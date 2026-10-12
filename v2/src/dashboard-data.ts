// SPDX-License-Identifier: MIT-0
import { HORIZONS, type HorizonKey, type ScoreItem } from "./score.js";

/**
 * Pure shaping for the local dashboard: the page receives these, computed from
 * the same audit rows the daily letter reads. No I/O in this module so every
 * function is unit-testable; dashboard.ts does the fetching.
 */

/** The slice of a daily-report EventRow the dashboard needs (structural, so no import). */
export interface RawEvent {
  id: string;
  at: string;
  headline?: string;
  materiality?: number;
  touches?: boolean;
  eventType?: string;
  decisions?: any[];
  cost?: number;
  turns?: number;
  degraded?: boolean;
  trigger?: string;
  model?: string;
  skipped?: string;
  deduped?: boolean;
  suppressed?: { symbol: string; move_pct: number; reason: string; kind?: string };
  proposals?: { accepted: number; rejected: number; checks: Record<string, number> };
  rejections?: string[];
  curiosity?: boolean;
  /** At-cost reversals of rule-violating fills (admin/unwind-legacy.ts); never trades. */
  corrections?: Array<{ at: string; symbol: string; qty: number; avg_cost: number; reason: string; unrealized_removed_usd: number }>;
  executions: any[];
}

export interface CompactDecision {
  action: string;
  symbol?: string;
  notional?: number;
  confidence: number;
  watch?: string;
  limit?: number;
}

export interface CompactFill {
  side: string;
  qty: number;
  symbol: string;
  price: number;
  deferred: boolean;
}

export interface CompactEvent {
  id: string;
  at: string;
  atMs: number;
  headline: string;
  trigger?: string;
  materiality?: number;
  touches?: boolean;
  eventType?: string;
  investigated: boolean;
  errored: boolean;
  cost?: number;
  turns?: number;
  model?: string;
  decisions: CompactDecision[];
  fills: CompactFill[];
  parked: number;
  dropped: string[];
  settled: number;
  skipped?: string;
  deduped: boolean;
  suppressed?: { symbol: string; movePct: number; reason: string; kind: string };
  /** v3: world-model proposals during this investigation and the gate's rulings. */
  proposals?: { accepted: number; rejected: number; checks: Record<string, number> };
  rejections: string[];
  curiosity: boolean;
}

export function shortModel(id: string): string {
  return id.replace(/^.*?claude-/, "").replace(/-v\d+:\d+$/, "");
}

export function compactEvent(e: RawEvent, errored: boolean): CompactEvent {
  const fills: CompactFill[] = e.executions
    .filter((x) => x.status === "filled" || x.pending_fill)
    .map((x) => ({
      side: String(x.fill?.side ?? ""),
      qty: Number(x.fill?.qty ?? 0),
      symbol: String(x.fill?.symbol ?? ""),
      price: Number(x.fill?.fillPrice ?? 0),
      deferred: !!x.pending_fill,
    }));
  return {
    id: e.id,
    at: e.at,
    atMs: Date.parse(e.at),
    headline: String(e.headline ?? "").replace(/\s+/g, " ").slice(0, 160),
    trigger: e.trigger,
    materiality: e.materiality,
    touches: e.touches,
    eventType: e.eventType,
    investigated: Array.isArray(e.decisions),
    errored,
    cost: e.cost,
    turns: e.turns,
    model: e.model ? shortModel(e.model) : undefined,
    decisions: (e.decisions ?? []).map((d: any) => ({
      action: String(d.action),
      symbol: d.symbol ? String(d.symbol) : undefined,
      notional: Number.isFinite(Number(d.notional_usd)) ? Number(d.notional_usd) : undefined,
      confidence: Number(d.confidence ?? 0),
      watch: d.watch_symbol ? String(d.watch_symbol) : undefined,
      limit: Number.isFinite(Number(d.limit_price)) ? Number(d.limit_price) : undefined,
    })),
    fills,
    parked: e.executions.filter((x) => String(x.sk).includes("order-parked")).length,
    dropped: e.executions.filter((x) => x.status === "dropped").map((x) => String(x.reason ?? "dropped")),
    settled: e.executions.filter((x) => String(x.sk).includes("settlement")).length,
    skipped: e.decisions ? undefined : e.skipped,
    deduped: !!e.deduped,
    suppressed: e.suppressed
      ? { symbol: e.suppressed.symbol, movePct: e.suppressed.move_pct, reason: e.suppressed.reason, kind: e.suppressed.kind ?? "budget" }
      : undefined,
    proposals: e.proposals,
    rejections: e.rejections ?? [],
    curiosity: !!e.curiosity || e.trigger === "curiosity",
  };
}

export interface PulseBucket {
  tMs: number;
  triaged: number;
  investigated: number;
  fills: number;
  alerts: number;
  suppressed: number;
}

/** Hourly activity buckets from sinceMs (floored to the hour) through nowMs. */
export function hourlyPulse(events: CompactEvent[], sinceMs: number, nowMs: number): PulseBucket[] {
  const H = 3_600_000;
  const start = Math.floor(sinceMs / H) * H;
  const n = Math.max(1, Math.ceil((nowMs - start) / H));
  const buckets: PulseBucket[] = Array.from({ length: n }, (_, i) => ({
    tMs: start + i * H,
    triaged: 0,
    investigated: 0,
    fills: 0,
    alerts: 0,
    suppressed: 0,
  }));
  for (const e of events) {
    const i = Math.floor((e.atMs - start) / H);
    if (i < 0 || i >= n) continue;
    const b = buckets[i];
    if (e.materiality !== undefined) b.triaged++;
    if (e.investigated) b.investigated++;
    b.fills += e.fills.length;
    if (e.trigger === "position-watch") b.alerts++;
    if (e.suppressed) b.suppressed++;
  }
  return buckets;
}

export interface ScoreRow {
  group: "trades" | "holds";
  horizon: HorizonKey;
  n: number;
  meanPct: number;
  /** Share of observations with a positive signed return. */
  positivePct: number;
  /** Share where the decision was right: trades = positive; holds = the declined buy did NOT gain. */
  rightPct: number;
}

export function scoreRows(items: ScoreItem[]): ScoreRow[] {
  const out: ScoreRow[] = [];
  for (const group of ["trades", "holds"] as const) {
    const xs = items.filter((i) => (group === "trades" ? i.action !== "hold" : i.action === "hold"));
    for (const h of Object.keys(HORIZONS) as HorizonKey[]) {
      const attr = `ret_${h}` as "ret_1h" | "ret_1d" | "ret_7d";
      const vals = xs.map((i) => i[attr]).filter((v): v is number => typeof v === "number");
      if (vals.length === 0) continue;
      const meanPct = (vals.reduce((a, b) => a + b, 0) / vals.length) * 100;
      const positivePct = (vals.filter((v) => v > 0).length / vals.length) * 100;
      out.push({
        group,
        horizon: h,
        n: vals.length,
        meanPct,
        positivePct,
        rightPct: group === "trades" ? positivePct : 100 - positivePct,
      });
    }
  }
  return out;
}

export interface CurvePoint {
  tMs: number;
  value: number;
}

export interface CurveSeries {
  key: string;
  label: string;
  /** focus = v2 (the control), arm = v3 (world model), identity = v1 (reference), context = benchmarks in gray. */
  role: "focus" | "arm" | "identity" | "context";
  points: CurvePoint[];
}

/** A benchmark as the value of `seed` dollars bought at `baseClose`, from the base date on. */
export function indexedSeries(
  closes: { tMs: number; close: number }[],
  baseClose: number,
  baseTMs: number,
  seed: number,
): CurvePoint[] {
  if (!(baseClose > 0)) return [];
  return closes
    .filter((c) => c.tMs >= baseTMs && c.close > 0)
    .sort((a, b) => a.tMs - b.tMs)
    .map((c) => ({ tMs: c.tMs, value: (seed * c.close) / baseClose }));
}

/** Local noon of a YYYY-MM-DD day label, for plotting a daily snapshot. */
export function dayNoonMs(day: string): number {
  return new Date(`${day}T12:00:00`).getTime();
}

// ---------------------------------------------------------------------------
// Book corrections, orders, mandate, bench — pure shaping added 2026-09-10.

export interface CompactCorrection {
  at: string;
  atMs: number;
  symbol: string;
  qty: number;
  avgCost: number;
  costBasis: number;
  unrealizedRemovedUsd: number;
  reason: string;
}

/** Every at-cost reversal in the window, newest first. */
export function compactCorrections(events: RawEvent[]): CompactCorrection[] {
  const out: CompactCorrection[] = [];
  for (const e of events) {
    for (const c of e.corrections ?? []) {
      out.push({
        at: c.at,
        atMs: Date.parse(c.at),
        symbol: c.symbol,
        qty: c.qty,
        avgCost: c.avg_cost,
        costBasis: Math.abs(c.qty) * c.avg_cost,
        unrealizedRemovedUsd: c.unrealized_removed_usd,
        reason: c.reason,
      });
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

/** The fields of pending.ts's PendingOrder the dashboard reads (structural: no AWS import). */
export interface PendingLike {
  symbol: string;
  kind?: string;
  side: "buy" | "sell";
  notional_usd: number;
  limit_price?: number;
  confidence: number;
  news_id: string;
  created_at: string;
  expires_at: string;
  parked_reason: string;
  rationale: string;
  reduce_only?: boolean;
  requested_usd?: number;
  filled_usd?: number;
  not_before?: string;
}

export interface OrderView {
  symbol: string;
  kind: string | null;
  side: "buy" | "sell";
  /** What is still to be filled. */
  remainingUsd: number;
  limitPrice: number | null;
  reason: string;
  /** A liquidity-capped exit still slicing the book (reduce-only). */
  working: boolean;
  requestedUsd: number | null;
  filledUsd: number;
  /** filled / requested, 0–100; null for a plain parked order. */
  progressPct: number | null;
  nextSliceMs: number | null;
  /** ms until the next slice may run; 0 when due; null for a plain parked order. */
  nextSliceInMs: number | null;
  createdMs: number;
  expiresMs: number;
  expiresInMs: number;
  confidence: number;
  rationale: string;
  newsId: string;
}

function toOrderView(o: PendingLike, nowMs: number): OrderView {
  const working = !!o.reduce_only;
  const requested = working ? (o.requested_usd ?? o.notional_usd + (o.filled_usd ?? 0)) : null;
  const filled = o.filled_usd ?? 0;
  const nextSliceMs = working && o.not_before ? Date.parse(o.not_before) : null;
  const expiresMs = Date.parse(o.expires_at);
  return {
    symbol: o.symbol,
    kind: o.kind ?? null,
    side: o.side,
    remainingUsd: o.notional_usd,
    limitPrice: o.limit_price ?? null,
    reason: o.parked_reason,
    working,
    requestedUsd: requested,
    filledUsd: filled,
    progressPct: requested && requested > 0 ? Math.min(100, (filled / requested) * 100) : null,
    nextSliceMs,
    nextSliceInMs: nextSliceMs === null ? null : Math.max(0, nextSliceMs - nowMs),
    createdMs: Date.parse(o.created_at),
    expiresMs,
    expiresInMs: expiresMs - nowMs,
    confidence: o.confidence,
    rationale: o.rationale,
    newsId: o.news_id,
  };
}

/** Split PENDING# rows into working exits (sliced) and plain parked orders, soonest-expiring first. */
export function describeOrders(pending: PendingLike[], nowMs: number): { working: OrderView[]; parked: OrderView[] } {
  const views = pending.map((o) => toOrderView(o, nowMs)).sort((a, b) => a.expiresMs - b.expiresMs);
  return { working: views.filter((v) => v.working), parked: views.filter((v) => !v.working) };
}

export interface MandateLimits {
  minDeployedPct: number;
  maxDeployedPct: number;
  minPositions: number;
  maxPositions: number;
  maxPositionPct: number;
}

export interface MandateView extends MandateLimits {
  equityUsd: number | null;
  deployedUsd: number;
  /** Gross deployed / equity as a fraction; null without an equity figure. */
  deployedPct: number | null;
  positions: number;
  largestPositionPct: number | null;
  status: "under" | "in-band" | "over" | "unknown";
  /** Dollars short of the floor (under) or above the ceiling (over); 0 in band. */
  gapUsd: number;
  positionsStatus: "few" | "in-band" | "many";
}

/** Where the book sits against the deployment mandate (mirrors mandate.ts's wording for the agent). */
export function mandateStatus(
  util: { equityUsd: number | null; deployedUsd: number; deployedPct: number | null; positions: number },
  m: MandateLimits,
  largestPositionPct: number | null,
): MandateView {
  let status: MandateView["status"] = "unknown";
  let gapUsd = 0;
  if (util.equityUsd !== null && util.deployedPct !== null) {
    if (util.deployedPct < m.minDeployedPct) {
      status = "under";
      gapUsd = m.minDeployedPct * util.equityUsd - util.deployedUsd;
    } else if (util.deployedPct > m.maxDeployedPct) {
      status = "over";
      gapUsd = util.deployedUsd - m.maxDeployedPct * util.equityUsd;
    } else status = "in-band";
  }
  const positionsStatus: MandateView["positionsStatus"] =
    util.positions < m.minPositions ? "few" : util.positions > m.maxPositions ? "many" : "in-band";
  return { ...m, equityUsd: util.equityUsd, deployedUsd: util.deployedUsd, deployedPct: util.deployedPct, positions: util.positions, largestPositionPct, status, gapUsd, positionsStatus };
}

export interface BenchRow {
  name: string;
  variant: string;
  ranAt: string | null;
  windowDays: number | null;
  window: string | null;
  eventsSeen: number;
  triagePassed: number;
  decided: number;
  buys: number;
  sells: number;
  holds: number;
  filled: number;
  dropped: number;
  errored: number;
  unscoreable: number;
  /** Mean signed 1-day / 7-day return of the variant's trades, as fractions; null when nothing scored. */
  tradeMeanRet1d: number | null;
  tradeMeanRet7d: number | null;
  costUsd: number;
  threshold: number | null;
}

const n0 = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** BENCHSUM rows (sk `<name>#<variant>`) as table rows, newest run first. */
export function benchRows(items: Array<Record<string, unknown>>): BenchRow[] {
  return items
    .map((i) => {
      const sk = String(i.sk ?? "");
      const hash = sk.indexOf("#");
      const ranAt = (i.ran_at ?? i.finished_at ?? i.generated_at) as string | undefined;
      const ret = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
      return {
        name: String(i.bench ?? i.name ?? (hash >= 0 ? sk.slice(0, hash) : sk)),
        variant: String(i.variant ?? (hash >= 0 ? sk.slice(hash + 1) : "live")),
        ranAt: ranAt ? String(ranAt) : null,
        windowDays: Number.isFinite(Number(i.window_days)) ? Number(i.window_days) : null,
        window: i.window ? String(i.window) : null,
        eventsSeen: n0(i.events_seen),
        triagePassed: n0(i.triage_passed),
        decided: n0(i.decided),
        buys: n0(i.buys),
        sells: n0(i.sells),
        holds: n0(i.holds),
        filled: n0(i.filled),
        dropped: n0(i.dropped),
        errored: n0(i.errored),
        unscoreable: n0(i.unscoreable),
        tradeMeanRet1d: ret(i.trade_mean_ret_1d),
        tradeMeanRet7d: ret(i.trade_mean_ret_7d),
        costUsd: n0(i.cost_usd),
        threshold: Number.isFinite(Number(i.triage_threshold)) ? Number(i.triage_threshold) : null,
      };
    })
    .sort((a, b) => (b.ranAt ?? "").localeCompare(a.ranAt ?? "") || a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant));
}

// ---------------------------------------------------------------------------
// Arms registry shaping (arms.json): roles on the equity chart, tile order,
// and the operations probes' platform rules. Pure, so the dashboard's arm
// handling is unit-tested without AWS or a supervisor.

export type ArmRole = "focus" | "arm" | "identity";

/**
 * focus = the arm this process follows (config.arm); identity = a pipeline arm,
 * seeded earlier and shown at actual equity; arm = any other agent arm.
 */
export function armRole(arm: { key: string; kind: "agent" | "pipeline" }, focusKey: string): ArmRole {
  if (arm.key === focusKey) return "focus";
  return arm.kind === "pipeline" ? "identity" : "arm";
}

/** Focus first, then the other agent arms in registry order, then pipeline arms. */
export function orderArmKeys(arms: { key: string; kind: "agent" | "pipeline" }[], focusKey: string): string[] {
  const rank = (a: { key: string; kind: string }): number => (a.key === focusKey ? 0 : a.kind === "agent" ? 1 : 2);
  return arms
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)
    .map((x) => x.a.key);
}

export type Supervisor = "launchd" | "systemd" | "none";

/** V2_SUPERVISOR when valid, else launchd on darwin and none elsewhere. */
export function defaultSupervisor(platform: string, env?: string): Supervisor {
  if (env === "launchd" || env === "systemd" || env === "none") return env;
  return platform === "darwin" ? "launchd" : "none";
}

/** The unit a supervisor knows an arm's process by; null when there is no supervisor. */
export function supervisorUnit(kind: Supervisor, prefix: string, key: string, role: "worker" | "daily-report"): string | null {
  if (kind === "launchd") return `com.${prefix}.${key}-${role}`;
  if (kind === "systemd") return role === "worker" ? `${prefix}-worker@${key}.service` : `${prefix}-letter.service`;
  return null;
}

/**
 * Where an arm's worker log lives: V2_WORKER_LOG_PATTERN with <prefix> and <key>
 * substituted and a leading ~ expanded, else ~/Library/Logs/<prefix>-<key>-worker.log
 * on darwin and /var/log/<prefix>/<key>-worker.log elsewhere.
 */
export function workerLogPath(o: { pattern?: string; platform: string; home: string; prefix: string; key: string }): string {
  const pattern =
    o.pattern && o.pattern.trim()
      ? o.pattern
      : o.platform === "darwin"
        ? "~/Library/Logs/<prefix>-<key>-worker.log"
        : "/var/log/<prefix>/<key>-worker.log";
  return pattern.replace(/<prefix>/g, o.prefix).replace(/<key>/g, o.key).replace(/^~(?=\/|$)/, o.home);
}

/** CUPS is probed only on darwin and only when printing is configured (V2_PRINT or V2_PRINTER). */
export function printerProbesEnabled(platform: string, env: { V2_PRINT?: string; V2_PRINTER?: string }): boolean {
  return platform === "darwin" && (!!(env.V2_PRINT && env.V2_PRINT.trim()) || !!(env.V2_PRINTER && env.V2_PRINTER.trim()));
}

export interface SupervisorState {
  /** running | not running | waiting | failed | not loaded | unknown */
  state: string;
  pid: number | null;
  lastExitCode: number | null;
  runs: number | null;
}

/** `launchctl print gui/<uid>/<label>` → state, pid, last exit code, run count. */
export function parseLaunchdPrint(stdout: string): SupervisorState {
  // launchd prints "state = running" or "state = not running" (and, rarely, "waiting").
  const state = /\bstate = (not running|running|waiting|\w+)/.exec(stdout)?.[1] ?? "unknown";
  const pid = /\bpid = (\d+)/.exec(stdout)?.[1];
  const exit = /last exit code = (-?\d+)/.exec(stdout)?.[1];
  const runs = /\bruns = (\d+)/.exec(stdout)?.[1];
  return { state, pid: pid ? Number(pid) : null, lastExitCode: exit !== undefined ? Number(exit) : null, runs: runs ? Number(runs) : null };
}

/** `systemctl show <unit> -p LoadState,ActiveState,MainPID,ExecMainStatus,NRestarts` → the same shape. */
export function parseSystemctlShow(stdout: string): SupervisorState {
  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const active = kv.get("ActiveState") ?? "unknown";
  const state =
    kv.get("LoadState") === "not-found"
      ? "not loaded"
      : active === "active"
        ? "running"
        : active === "failed"
          ? "failed"
          : active === "unknown"
            ? "unknown"
            : "not running";
  const pid = Number(kv.get("MainPID") ?? 0);
  const exit = kv.get("ExecMainStatus");
  const runs = kv.get("NRestarts");
  return {
    state,
    pid: pid > 0 ? pid : null,
    lastExitCode: exit !== undefined && exit !== "" ? Number(exit) : null,
    runs: runs !== undefined && runs !== "" ? Number(runs) : null,
  };
}
