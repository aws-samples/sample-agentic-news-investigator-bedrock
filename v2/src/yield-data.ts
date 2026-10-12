// SPDX-License-Identifier: MIT-0
/**
 * Yield-aware triage: which kinds of news have paid for their investigations.
 *
 * Pure computation and rendering — no AWS, no clock — so it is unit-tested from
 * fixtures; `yield.ts` reads the rows and stores the table, `worker.ts` applies
 * it at admission when `config.yieldTriage.enabled`.
 *
 * A category is `<trigger>|<event type>`: the poller family that produced the
 * item (edgar, disaster, macro, crypto, …) and Haiku's triage event type
 * (corporate, macro, disaster, political, …); internal triggers (position-watch,
 * daily-review, curiosity) have no event type. Per category we measure, with an
 * exponential decay so recent weeks weigh more:
 *
 *   cost   — LLM spend of every investigation in the category;
 *   P&L    — for investigations old enough to have a 7-day score ("matured"),
 *            filled notional × signed 7-day return of each trade (score.ts
 *            signs returns so positive = the decision's direction was right),
 *            with the return bounded to ±100%: a prediction contract going
 *            from 2¢ to 40¢ scores +1900% and would otherwise let one fill
 *            set its whole category's bar;
 *   yield  — matured P&L per matured LLM dollar, shrunk toward the global yield
 *            by `minN` pseudo-observations so a category with three data points
 *            cannot swing its own bar.
 *
 * The bar moves around the base materiality threshold: a category whose shrunk
 * yield is at or below zero gets `base + maxShift`, one at the global yield gets
 * `base`, one at twice the global yield or better gets `base − maxShift`,
 * clamped to [floor, ceil]. When the global yield is not positive nothing has
 * information and every bar is the base. News touching a held instrument keeps
 * the held bar regardless (position management is not a yield question), and an
 * exploration floor admits a few sub-bar items per category per day so a starved
 * category can still prove itself.
 *
 * Why (2026-09-19 analysis of three weeks of v2): position alerts took 42% of
 * spend at a 43% hit rate; disasters were triaged at the highest median
 * materiality (0.72) while 2% produced a decision; EDGAR corporate and macro
 * returned roughly $10 and $35 of paper P&L per LLM dollar.
 */

export interface YieldTriageRow {
  newsId: string;
  trigger: string;
  eventType: string | undefined;
  materiality: number;
  atMs: number;
}

export interface YieldDecisionAction {
  action: string;
  symbol: string | null;
  notionalUsd: number | null;
  /** score/order id: the news id for a single action, `<news>#<i>` otherwise. */
  actionId: string;
}

export interface YieldDecisionRow {
  newsId: string;
  trigger: string;
  costUsd: number;
  atMs: number;
  actions: YieldDecisionAction[];
}

export interface YieldScoreRow {
  /** Matches an action id. */
  actionId: string;
  symbol: string;
  action: string;
  /** Signed 7-day return as a fraction (positive = direction right); null when not yet known. */
  ret7d: number | null;
}

export interface YieldOrderRow {
  /** Matches an action id. */
  decisionId: string;
  notionalUsd: number;
}

export interface YieldParams {
  nowMs: number;
  halfLifeDays: number;
  /** Pseudo-observations of the global yield mixed into every category. */
  minN: number;
  /** Decisions younger than this have no 7-day score yet and are left out of the yield. */
  maturityDays: number;
  baseThreshold: number;
  maxShift: number;
  floor: number;
  ceil: number;
}

export interface YieldCategory {
  category: string;
  /** Raw counts, no decay. */
  n: number;
  actions: number;
  costUsd: number;
  /** Matured, decay-weighted figures the yield is computed from. */
  nMatured: number;
  nEff: number;
  costEff: number;
  pnlEff: number;
  scored: number;
  hit7d: number | null;
  yieldRaw: number | null;
  yieldShrunk: number | null;
  threshold: number;
  /** Median triage materiality of the category's investigated items, for the report. */
  medianMateriality: number | null;
}

export interface YieldTable {
  computedAtIso: string;
  params: Omit<YieldParams, "nowMs">;
  global: { n: number; costUsd: number; costEff: number; pnlEff: number; yield: number | null };
  categories: YieldCategory[];
}

export const INTERNAL_TRIGGERS = new Set(["position-watch", "daily-review", "curiosity"]);

export function categoryOf(trigger: string | undefined, eventType: string | undefined): string {
  const t = (trigger ?? "?").trim().toLowerCase() || "?";
  if (INTERNAL_TRIGGERS.has(t)) return `${t}|-`;
  const e = (eventType ?? "?").trim().toLowerCase().split("|")[0] || "?";
  return `${t}|${e}`;
}

const DAY_MS = 86_400_000;
/** Per-trade 7-day return bound used for P&L attribution (see the header). */
export const RETURN_CAP = 1;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export function decayWeight(atMs: number, nowMs: number, halfLifeDays: number): number {
  if (!(halfLifeDays > 0)) return 1;
  const age = Math.max(0, nowMs - atMs) / DAY_MS;
  return Math.pow(0.5, age / halfLifeDays);
}

/** Where a category's bar sits, given its shrunk yield and the global yield. */
export function thresholdFor(yieldShrunk: number | null, globalYield: number | null, p: Omit<YieldParams, "nowMs">): number {
  const base = clamp(p.baseThreshold, p.floor, p.ceil);
  if (yieldShrunk === null || globalYield === null || !(globalYield > 0)) return base;
  const ratio = clamp(yieldShrunk / (2 * globalYield), 0, 1);
  return clamp(base + p.maxShift - 2 * p.maxShift * ratio, p.floor, p.ceil);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function aggregateYield(
  input: { triage: YieldTriageRow[]; decisions: YieldDecisionRow[]; scores: YieldScoreRow[]; orders: YieldOrderRow[] },
  p: YieldParams,
): YieldTable {
  const eventTypeByNews = new Map<string, { eventType: string | undefined; materiality: number }>();
  for (const t of input.triage) eventTypeByNews.set(t.newsId, { eventType: t.eventType, materiality: t.materiality });
  const scoreByAction = new Map<string, YieldScoreRow[]>();
  for (const s of input.scores) {
    const list = scoreByAction.get(s.actionId) ?? [];
    list.push(s);
    scoreByAction.set(s.actionId, list);
  }
  const notionalByAction = new Map<string, number>();
  for (const o of input.orders) notionalByAction.set(o.decisionId, (notionalByAction.get(o.decisionId) ?? 0) + o.notionalUsd);

  type Acc = YieldCategory & { mats: number[]; pos7: number };
  const cats = new Map<string, Acc>();
  const acc = (c: string): Acc => {
    let a = cats.get(c);
    if (!a) {
      a = { category: c, n: 0, actions: 0, costUsd: 0, nMatured: 0, nEff: 0, costEff: 0, pnlEff: 0, scored: 0, hit7d: null, yieldRaw: null, yieldShrunk: null, threshold: p.baseThreshold, medianMateriality: null, mats: [], pos7: 0 };
      cats.set(c, a);
    }
    return a;
  };
  const maturityMs = p.maturityDays * DAY_MS;
  let gCost = 0;
  let gPnl = 0;
  let gN = 0;

  for (const d of input.decisions) {
    const tri = eventTypeByNews.get(d.newsId);
    const c = categoryOf(d.trigger, tri?.eventType);
    const a = acc(c);
    a.n++;
    a.costUsd += d.costUsd;
    a.actions += d.actions.filter((x) => x.action !== "hold").length;
    if (tri && Number.isFinite(tri.materiality)) a.mats.push(tri.materiality);
    if (p.nowMs - d.atMs < maturityMs) continue; // no 7-day score can exist yet
    const w = decayWeight(d.atMs, p.nowMs, p.halfLifeDays);
    a.nMatured++;
    a.nEff += w;
    a.costEff += w * d.costUsd;
    gCost += w * d.costUsd;
    gN += w;
    for (const x of d.actions) {
      if (x.action === "hold") continue;
      const scores = scoreByAction.get(x.actionId) ?? [];
      const s = scores.find((r) => r.symbol === x.symbol) ?? scores[0];
      if (!s || typeof s.ret7d !== "number") continue;
      const notional = notionalByAction.get(x.actionId) ?? x.notionalUsd ?? 0;
      const ret = clamp(s.ret7d, -RETURN_CAP, RETURN_CAP);
      const pnl = notional * ret;
      a.scored++;
      if (s.ret7d > 0) a.pos7++;
      a.pnlEff += w * pnl;
      gPnl += w * pnl;
    }
  }

  const gYield = gCost > 0 ? gPnl / gCost : null;
  const params = { halfLifeDays: p.halfLifeDays, minN: p.minN, maturityDays: p.maturityDays, baseThreshold: p.baseThreshold, maxShift: p.maxShift, floor: p.floor, ceil: p.ceil };
  const categories: YieldCategory[] = [...cats.values()]
    .map((a) => {
      const yieldRaw = a.costEff > 0 ? a.pnlEff / a.costEff : null;
      const yieldShrunk =
        yieldRaw === null || gYield === null ? null : (a.nEff * yieldRaw + p.minN * gYield) / (a.nEff + p.minN);
      const { mats, pos7, ...rest } = a;
      return {
        ...rest,
        hit7d: a.scored > 0 ? (pos7 / a.scored) * 100 : null,
        yieldRaw,
        yieldShrunk,
        threshold: thresholdFor(yieldShrunk, gYield, params),
        medianMateriality: median(mats),
      };
    })
    .sort((x, y) => y.costUsd - x.costUsd);
  return {
    computedAtIso: new Date(p.nowMs).toISOString(),
    params,
    global: { n: gN, costUsd: input.decisions.reduce((s, d) => s + d.costUsd, 0), costEff: gCost, pnlEff: gPnl, yield: gYield },
    categories,
  };
}

// ---------------------------------------------------------------------------
// Admission (used live by the worker and by the bench variant)

export interface AdmissionConfig {
  triageThreshold: number;
  heldTriageThreshold: number;
  explorationPerDay: number;
}

export interface Admission {
  admitted: boolean;
  category: string;
  /** The bar actually applied. */
  threshold: number;
  /** The bar the flat rule would have applied. */
  baseThreshold: number;
  yieldPerDollar: number | null;
  /** True when a sub-bar item was let through by the exploration floor. */
  explored: boolean;
  reason: string;
}

/**
 * Decide whether an item goes on to investigation. `exploredToday` is how many
 * items in this category the exploration floor has already admitted today.
 */
export function admitForYield(
  verdict: { materiality: number; touches_positions: boolean; event_type?: string },
  trigger: string | undefined,
  table: YieldTable | null,
  exploredToday: number,
  cfg: AdmissionConfig,
): Admission {
  const category = categoryOf(trigger, verdict.event_type);
  const base = verdict.touches_positions ? cfg.heldTriageThreshold : cfg.triageThreshold;
  const row = table?.categories.find((c) => c.category === category) ?? null;
  const y = row?.yieldShrunk ?? null;
  // Held news is position management: the held bar stands whatever the yield says.
  let threshold = verdict.touches_positions || !row ? base : row.threshold;
  let explored = false;
  if (!verdict.touches_positions && row && threshold > base && exploredToday < cfg.explorationPerDay && verdict.materiality >= base) {
    threshold = base;
    explored = true;
  }
  const admitted = verdict.materiality >= threshold;
  const yTxt = y === null ? "no yield data" : `yield $${y.toFixed(2)}/$`;
  const reason = admitted
    ? explored
      ? `${category}: exploring (bar ${row!.threshold.toFixed(2)} → ${base.toFixed(2)}, ${yTxt})`
      : `${category}: ${verdict.materiality.toFixed(2)} ≥ ${threshold.toFixed(2)} (${yTxt})`
    : `${category}: ${verdict.materiality.toFixed(2)} < ${threshold.toFixed(2)} (${yTxt})`;
  return { admitted, category, threshold, baseThreshold: base, yieldPerDollar: y, explored, reason };
}

// ---------------------------------------------------------------------------
// Rendering

const f2 = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(2));

export function renderYieldTable(t: YieldTable): string {
  const head = `yield table (bars apply to news categories; internal triggers are listed for cost only) · computed ${t.computedAtIso.slice(0, 16)}Z · half-life ${t.params.halfLifeDays}d · minN ${t.params.minN} · base ${t.params.baseThreshold} ± ${t.params.maxShift} in [${t.params.floor}, ${t.params.ceil}] · global yield ${t.global.yield === null ? "—" : `$${t.global.yield.toFixed(2)} per LLM $`}`;
  const cols = "category                      n   $cost   acts  matured  scored  hit7d   pnl(w)    yield  shrunk    bar  med.mat";
  const rows = t.categories.map(
    (c) =>
      `${c.category.padEnd(28)} ${String(c.n).padStart(4)} ${c.costUsd.toFixed(0).padStart(7)} ${String(c.actions).padStart(6)} ${String(c.nMatured).padStart(8)} ${String(c.scored).padStart(7)} ${(c.hit7d === null ? "—" : `${c.hit7d.toFixed(0)}%`).padStart(6)} ${c.pnlEff.toFixed(0).padStart(8)} ${f2(c.yieldRaw).padStart(8)} ${f2(c.yieldShrunk).padStart(7)} ${c.threshold.toFixed(2).padStart(6)} ${f2(c.medianMateriality).padStart(8)}`,
  );
  return [head, cols, ...rows].join("\n");
}
