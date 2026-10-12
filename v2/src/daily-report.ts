// SPDX-License-Identifier: MIT-0
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  stripLeadingTitle,
  normalizeHeadings,
  windowSpend,
  windowLabel,
  windowStart,
  coverageGaps,
  fmtLocal,
  fmtLocalWeekday,
  localZone,
  summaryHeadline,
  newsFlowLines,
  type NewsFlowRow,
  type WindowBasis,
} from "./letter.js";
import { renderNarrativePdf, printPdf } from "./print.js";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ScanCommand, QueryCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { config, arms } from "./config.js";
import { tableFor } from "./arms.js";
import { ddb, listPositions, getPortfolioOf } from "./ledger.js";
import { listPending } from "./pending.js";
import { listScoreItems, HORIZONS, type HorizonKey, type ScoreItem } from "./score.js";
import { resolve, inferKind } from "./quotes/resolver.js";
import { liquidationPrice } from "./exec.js";
import { streamMessage } from "./bedrock.js";
import { priceUsage, normalizeUsage, type NormalizedUsage } from "./pricing.js";
import {
  computePerf,
  benchmarkReturns,
  formatPerf,
  type PerfPosition,
} from "./performance.js";

/**
 * Daily ops report: deterministic data appendix + a Fable-written narrative
 * that reads the PREVIOUS days' reports, so trends carry forward day to day.
 * Output: v2/reports/YYYY-MM-DD.md. Run manually (npm run daily-report) or via
 * the supervisor's scheduled daily-report job for this arm (ops/).
 */

// src/ and dist/ are both direct children of v2/, so ../reports is v2/reports.
const REPORTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "reports",
);
/**
 * The pipeline (risk-gated, Rust) arm the letter cites as its reference, if the
 * registry has one; its table follows arms.json. Absent → the letter says so.
 */
export const PIPELINE_ARM = arms.arms.find((a) => a.kind === "pipeline") ?? null;
export const PIPELINE_TABLE = PIPELINE_ARM ? tableFor(PIPELINE_ARM, arms, { key: config.arm, table: config.table }) : null;
const PREV_REPORTS = 7;
const PREV_TRUNCATE = 3000;

export interface EventRow {
  id: string;
  at: string;
  headline?: string;
  materiality?: number;
  touches?: boolean;
  /** Triage's event_type and one-paragraph rationale (what the news is, why it matters). */
  eventType?: string;
  triageNote?: string;
  decisions?: any[];
  cost?: number;
  turns?: number;
  degraded?: boolean;
  trigger?: string;
  /** Model that produced the decision (recorded since 2026-09-02). */
  model?: string;
  /** The SDK/API failed before the agent answered; the recorded hold is a placeholder. */
  errored?: boolean;
  /** Material news the budget breaker refused to investigate (reason string). */
  skipped?: string;
  /** Identical headline inside the dedupe window; never reached triage. */
  deduped?: boolean;
  /** A position-watch alert the budget breaker refused to investigate. */
  suppressed?: { symbol: string; move_pct: number; reason: string; kind?: string };
  /** v3: world-model proposals made during this investigation and how the gate ruled. */
  proposals?: { accepted: number; rejected: number; checks: Record<string, number> };
  rejections?: string[];
  /** v3: this investigation was asked for by the world model, not by news. */
  curiosity?: boolean;
  /** Administrative reversals at cost of fills that violated the broker's rules (admin/unwind-legacy.ts) — never trades. One run writes several rows under one id. */
  corrections?: Array<{ at: string; symbol: string; qty: number; avg_cost: number; reason: string; unrealized_removed_usd: number }>;
  executions: any[];
}

export async function gatherEvents(
  sinceMs: number,
  table = config.table,
): Promise<{ events: EventRow[]; rowMs: number[] }> {
  const byId = new Map<string, EventRow>();
  // Every row's timestamp, whatever its stage: the raw signal for processing gaps.
  const rowMs: number[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :n) AND begins_with(sk, :e)",
        ExpressionAttributeValues: { ":n": "NEWS#", ":e": "EVT#" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (r.Items ?? []) as any[]) {
      const ts = Date.parse(String(item.sk).split("#")[1]);
      if (!(ts >= sinceMs)) continue;
      const id = String(item.pk).slice(5);
      // Bench runs before 2026-09-03 wrote under NEWS#BENCH#…; they are test
      // artifacts, not news, and must not count as triaged items or as gaps filled.
      if (id.startsWith("BENCH#")) continue;
      rowMs.push(ts);
      const e = byId.get(id) ?? { id, at: String(item.sk).split("#")[1], executions: [] };
      const p = item.payload ?? {};
      if (item.stage === "v2-triage" || String(item.sk).includes("triage")) {
        e.headline = p.headline;
        e.materiality = p.materiality;
        e.touches = p.touches_positions;
        e.eventType = p.event_type;
        e.triageNote = p.rationale;
      } else if (String(item.sk).includes("v2-decision")) {
        e.decisions = p.decisions ?? (p.decision ? [p.decision] : []);
        e.cost = p.cost_usd;
        e.turns = p.num_turns;
        e.degraded = p.degraded;
        e.trigger = p.trigger;
        e.model = p.model;
        e.errored = p.errored === true;
        if (!e.headline) e.headline = p.headline ?? summaryHeadline(p.summary);
      } else if (String(item.sk).includes("v2-skipped")) {
        e.skipped = String(p.reason ?? "budget");
        if (!e.headline && p.headline) e.headline = p.headline;
        if (!e.trigger && p.trigger) e.trigger = p.trigger;
      } else if (String(item.sk).includes("v2-dedupe")) {
        e.deduped = true;
        if (!e.headline && p.headline) e.headline = p.headline;
      } else if (String(item.sk).includes("v2-watch-suppressed")) {
        e.suppressed = {
          symbol: String(p.symbol),
          move_pct: Number(p.move_pct),
          reason: String(p.reason ?? "budget"),
          kind: String(p.kind ?? "budget"),
        };
      } else if (String(item.sk).includes("v3-world-proposal")) {
        const accepted = p.verdict?.accepted === true;
        const check = String(p.verdict?.check ?? "none");
        e.proposals = e.proposals ?? { accepted: 0, rejected: 0, checks: {} };
        if (accepted) e.proposals.accepted++;
        else {
          e.proposals.rejected++;
          (e.rejections ??= []).push(`${check}: ${String(p.verdict?.reason ?? "")}`.slice(0, 200));
        }
        e.proposals.checks[check] = (e.proposals.checks[check] ?? 0) + 1;
      } else if (String(item.sk).includes("v3-curiosity")) {
        e.curiosity = true;
        if (!e.trigger) e.trigger = "curiosity";
        if (!e.headline && p.issue?.detail) e.headline = `World model check: ${p.issue.detail}`;
      } else if (String(item.sk).includes("v2-book-correction")) {
        e.trigger = "book-correction";
        if (!e.headline) e.headline = p.headline;
        (e.corrections ??= []).push({
          at: String(item.sk).split("#")[1],
          symbol: String(p.symbol),
          qty: Number(p.qty),
          avg_cost: Number(p.avg_cost),
          reason: String(p.reason ?? ""),
          unrealized_removed_usd: Number(p.unrealized_removed_usd ?? 0),
        });
      } else if (
        String(item.sk).includes("execution") ||
        String(item.sk).includes("order-") ||
        String(item.sk).includes("settlement")
      ) {
        e.executions.push({ sk: item.sk, ...p });
      }
      byId.set(id, e);
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return { events: [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)), rowMs };
}

async function equityOf(
  table: string,
): Promise<{ cash: number; equity: number; positions: string[]; rows: PerfPosition[] } | null> {
  const portfolio = await getPortfolioOf(table);
  if (!portfolio) return null;
  const positions = await listPositions(table);
  let value = 0;
  const lines: string[] = [];
  const rows: PerfPosition[] = [];
  for (const p of positions) {
    const res = await resolve(p.symbol, (p.kind as any) ?? inferKind(p.symbol));
    // Liquidation value (bid), not mid — thin books make mid a fiction.
    const price = res.ok ? liquidationPrice(res.quote, p.qty) : p.avg_cost;
    value += p.qty * price;
    rows.push({ symbol: p.symbol, qty: p.qty, avgCost: p.avg_cost, mark: price });
    const pnl = (price - p.avg_cost) * p.qty;
    const book =
      res.ok && res.quote.bid !== undefined && res.quote.ask !== undefined
        ? ` (book ${res.quote.bid}/${res.quote.ask}, depth $${res.quote.liquidityUsd ?? "?"})`
        : "";
    lines.push(
      `${p.symbol}: ${p.qty < 0 ? "SHORT " : ""}qty ${p.qty} @ entry ${p.avg_cost}, liquidation ${res.ok ? price : "unquotable"}${res.ok && res.quote.resolved ? " RESOLVED" : ""}${book}, unrealized ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(0)}`,
    );
  }
  return { cash: portfolio.cash, equity: portfolio.cash + value, positions: lines, rows };
}

interface FillSummary {
  fills: number;
  buyNotional: number;
  realized: number;
  firstAtIso: string | null;
}

/**
 * Every fill ever booked, for capital-committed and realized-P&L totals.
 * The two arms store orders differently: v2 (TypeScript) writes a payload map
 * with camelCase keys, v1 (Rust) writes a JSON *string* with snake_case ones.
 */
export async function gatherFills(table: string): Promise<FillSummary> {
  const acc: FillSummary = { fills: 0, buyNotional: 0, realized: 0, firstAtIso: null };
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :o)",
        ExpressionAttributeValues: { ":o": "ORDER#" },
        ProjectionExpression: "payload",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (r.Items ?? []) as any[]) {
      let f: any = item.payload;
      if (typeof f === "string") {
        try {
          f = JSON.parse(f);
        } catch {
          continue;
        }
      }
      if (!f) continue;
      const side = f.side;
      const notional = Number(f.notionalUsd ?? f.notional_usd ?? 0);
      const realized = Number(f.realizedPnl ?? f.realized_pnl ?? 0);
      const at = String(f.filledAt ?? f.filled_at ?? "");
      acc.fills += 1;
      if (side === "buy" && Number.isFinite(notional)) acc.buyNotional += notional;
      if (Number.isFinite(realized)) acc.realized += realized;
      if (at && (acc.firstAtIso === null || at < acc.firstAtIso)) acc.firstAtIso = at;
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return acc;
}

/**
 * Seed capital is not stored anywhere, but it is exactly recoverable:
 * cash = seed - buys + sells and openCost = buys - costOfSold, so
 * seed = cash + openCost - realized. Verified against both live books.
 */
export function impliedSeed(cash: number, rows: PerfPosition[], realized: number): number {
  const openCost = rows.reduce((sum, r) => sum + r.qty * r.avgCost, 0);
  return cash + openCost - realized;
}

export interface EquitySnapshot {
  equity: number;
  at: string;
}

/**
 * When an arm's paper account began: the STATE/INCEPTION row seed.ts writes into
 * its table (`at`), or null when the account predates that row — callers fall
 * back to the first fill. V2_INCEPTION (config.inceptionIso) overrides this for
 * the focus arm only.
 */
export async function readInception(table: string): Promise<string | null> {
  try {
    const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: "STATE", sk: "INCEPTION" } }));
    return r.Item?.at ? String(r.Item.at) : null;
  } catch {
    return null;
  }
}

/** Daily equity marks per arm (EQUITY / DAY#<day>#<arm key>), so later letters can compare like windows. */
export async function readSnapshots(arm: string): Promise<EquitySnapshot[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": "EQUITY", ":s": `DAY#` },
    }),
  );
  return ((r.Items ?? []) as any[])
    .filter((i) => String(i.sk).endsWith(`#${arm}`))
    .map((i) => ({ equity: Number(i.equity), at: String(i.sk).split("#")[1] }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

async function writeSnapshot(arm: string, day: string, equity: number, cash: number): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        pk: "EQUITY",
        sk: `DAY#${day}#${arm}`,
        arm,
        day,
        equity,
        cash,
        written_at: new Date().toISOString(),
      },
    }),
  );
}

interface ReportRun {
  day: string;
  generated_at: string;
  window_start: string;
  /** What writing the letter cost: the narrative call's reported usage, priced at narrative_model (pricing.ts). */
  narrative_usage?: NormalizedUsage;
  narrative_cost_usd?: number;
  narrative_model?: string;
}

const BASIS_TEXT: Record<WindowBasis, string> = {
  rerun: "same start as this day's earlier run (regenerated letter)",
  "previous-letter": "starts exactly where the previous letter's window ended",
  "previous-file": "starts at the previous report file's write time (no run anchor recorded yet)",
  "fallback-24h": "no previous letter found — trailing 24 hours",
};

/**
 * One row per letter (`REPORT` / `DAY#<local-day>`): when it ran and what it
 * covered. The next letter starts where this one's window ended.
 */
async function readReportRuns(): Promise<ReportRun[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": "REPORT", ":s": "DAY#" },
    }),
  );
  return ((r.Items ?? []) as any[])
    .map((i) => ({
      day: String(i.day),
      generated_at: String(i.generated_at),
      window_start: String(i.window_start),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function writeReportRun(run: ReportRun): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: { pk: "REPORT", sk: `DAY#${run.day}`, ...run },
    }),
  );
}

/** mtime of the newest report file from an earlier day, or null. */
function previousReportMtimeMs(day: string): number | null {
  try {
    const f = fs
      .readdirSync(REPORTS_DIR)
      .filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x) && x < `${day}.md`)
      .sort()
      .at(-1);
    return f ? fs.statSync(path.join(REPORTS_DIR, f)).mtimeMs : null;
  } catch {
    return null;
  }
}

/** Cumulative real LLM spend across every day, for the cost-of-running line. */
export async function totalSpend(table = config.table): Promise<number> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": "SPEND" },
    }),
  );
  return ((r.Items ?? []) as any[]).reduce((sum, i) => sum + Number(i.cost_usd ?? 0), 0);
}

/**
 * The letter is labelled by LOCAL date (the launchd job runs 08:00 local). A
 * hand-run after 20:00 EDT is already tomorrow in UTC and would misfile the
 * letter if it used the UTC date. The budget breaker keeps rolling on the UTC
 * dayKey. REPORT_DAY forces a specific day when regenerating an old letter; such
 * a run never advances the window anchor.
 */
function reportDay(now: Date): string {
  if (process.env.REPORT_DAY) return process.env.REPORT_DAY;
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const RET_ATTR: Record<HorizonKey, "ret_1h" | "ret_1d" | "ret_7d"> = {
  "1h": "ret_1h",
  "1d": "ret_1d",
  "7d": "ret_7d",
};

function scoreSummary(items: ScoreItem[]): string {
  const lines: string[] = [];
  for (const group of ["trades", "holds"] as const) {
    const xs = items.filter((i) => (group === "trades" ? i.action !== "hold" : i.action === "hold"));
    for (const h of Object.keys(HORIZONS) as HorizonKey[]) {
      const vals = xs.map((i) => i[RET_ATTR[h]]).filter((v): v is number => typeof v === "number");
      if (vals.length === 0) continue;
      const mean = (vals.reduce((a, b) => a + b, 0) / vals.length) * 100;
      const wins = vals.filter((v) => v > 0).length;
      const winPct = Math.round((wins / vals.length) * 100);
      if (group === "trades") {
        lines.push(
          `trades ${h}: n=${vals.length} mean ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}% in the trade's direction; ${winPct}% of trades were on the right side`,
        );
      } else {
        // A hold is scored as the buy the agent declined: its return is what was
        // given up, and a LOW share of positive outcomes means the holds were right.
        lines.push(
          `holds ${h}: n=${vals.length}; the declined buy would have returned ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}% on average and gained in ${winPct}% of cases — so ${100 - winPct}% of holds were vindicated at this horizon`,
        );
      }
    }
  }
  if (lines.length === 0) return "no scored horizons yet";
  return [
    "how to read these: a trade's return is signed in its own direction (positive = right). A hold is scored as the counterfactual BUY of the symbol it watched, so for holds a low share of gains is GOOD — it means the agent was right not to buy. Means are dominated by a few thin-book outliers; read the shares, not the means.",
    ...lines,
  ].join("\n");
}

/**
 * An investigation that died before the model answered (SDK/API error, e.g. the
 * 2026-09-01 20:02 "Claude Code 2.1.251 does not support this model"): flagged
 * explicitly since 2026-09-02; older rows are recognised by their shape — a
 * zero-cost run whose only decisions are zero-confidence holds.
 */
export function isErrored(e: EventRow): boolean {
  if (e.errored) return true;
  const ds = e.decisions ?? [];
  return ds.length > 0 && (e.cost ?? 0) === 0 && ds.every((d: any) => Number(d.confidence) === 0);
}

function shortModel(id: string): string {
  return id.replace(/^.*?claude-/, "").replace(/-v\d+:\d+$/, "");
}

const GAP_HOURS = 2;

/**
 * When the agent was NOT looking. Everything else in the appendix is a row the
 * agent wrote; this section is built from refusals and from the absence of rows,
 * so the letter can tell "quiet judgment" from "nobody was home". The 2026-09-02
 * letter blamed a twenty-hour blind spot on one failed API call when the log
 * showed a spent budget suppressing every alert, then an asleep laptop.
 */
export function coverageLines(
  events: EventRow[],
  c: { sinceMs: number; nowMs: number; rowMs: number[] },
): string[] {
  const out: string[] = [];
  const t = (iso: string) => iso.slice(5, 16);
  const gaps = coverageGaps(c.rowMs, c.sinceMs, c.nowMs, GAP_HOURS * 3_600_000);
  if (gaps.length === 0) {
    out.push(`processing gaps of ${GAP_HOURS}h or more: none — rows were being written throughout the window`);
  }
  for (const g of gaps) {
    const hours = ((g.toMs - g.fromMs) / 3_600_000).toFixed(1);
    out.push(
      `processing gap: ${fmtLocal(new Date(g.fromMs))} to ${fmtLocal(new Date(g.toMs))} local (${hours}h) — no rows of any kind were written. The worker was offline (host asleep, credential chain expired, no network) or no news arrived; either way the positions were NOT being watched.`,
    );
  }
  // Suppressed alerts recur every watch pass while the budget is spent; collapse per symbol.
  const bySym = new Map<string, EventRow[]>();
  for (const e of events) {
    if (!e.suppressed) continue;
    bySym.set(e.suppressed.symbol, [...(bySym.get(e.suppressed.symbol) ?? []), e]);
  }
  for (const [sym, xs] of bySym) {
    xs.sort((a, b) => a.at.localeCompare(b.at));
    const moves = xs.map((x) => x.suppressed!.move_pct);
    out.push(
      xs[0].suppressed!.kind === "thin-book"
        ? `position-watch alerts on ${sym} judged not events: ${xs.length}x from ${t(xs[0].at)} to ${t(xs.at(-1)!.at)} (moves ${Math.min(...moves).toFixed(1)}% to ${Math.max(...moves).toFixed(1)}%; ${xs[0].suppressed!.reason}). The marks flickered on a book too thin to transact against; nothing could have been sold or bought at those prices.`
        : `position-watch alerts suppressed on ${sym}: ${xs.length}x from ${t(xs[0].at)} to ${t(xs.at(-1)!.at)} (moves ${Math.min(...moves).toFixed(1)}% to ${Math.max(...moves).toFixed(1)}%; ${xs[0].suppressed!.reason}). The position moved and the agent was not asked.`,
    );
  }
  const skipped = events.filter((e) => e.skipped && !e.decisions);
  if (skipped.length > 0) {
    const reviews = skipped.filter((e) => e.trigger === "daily-review" || e.id.startsWith("review-"));
    out.push(
      `material news skipped by the budget breaker: ${skipped.length} events from ${t(skipped[0].at)} to ${t(skipped.at(-1)!.at)} (${skipped[0].skipped})${reviews.length > 0 ? ", including the daily portfolio review" : ""}`,
    );
  }
  for (const e of events.filter(isErrored)) {
    out.push(
      `errored investigation: ${t(e.at)} [${e.trigger ?? "news"}] "${String(e.headline).slice(0, 120)}" — no decision was actually made; the recorded hold is a placeholder`,
    );
  }
  return out;
}

/** One-line outcome of an investigation for the news-flow digest. */
function decisionOutcome(e: EventRow): string | undefined {
  const ds = e.decisions ?? [];
  if (ds.length === 0) return undefined;
  const d = ds.find((x: any) => x.action !== "hold") ?? ds[0];
  const filled = e.executions.some((x) => x.status === "filled" || x.pending_fill);
  return (
    `${d.action}${d.symbol ? ` ${d.symbol}` : ""}` +
    `${Number.isFinite(Number(d.notional_usd)) ? ` $${d.notional_usd}` : ""}` +
    `${d.watch_symbol && d.action === "hold" ? ` (watch ${d.watch_symbol})` : ""}` +
    `${filled ? " FILLED" : ""}${ds.length > 1 ? ` +${ds.length - 1} more` : ""}`
  );
}

function toNewsFlowRow(e: EventRow): NewsFlowRow {
  return {
    at: e.at,
    headline: String(e.headline ?? ""),
    materiality: Number(e.materiality ?? 0),
    touches: e.touches,
    eventType: e.eventType,
    note: e.triageNote,
    outcome: decisionOutcome(e),
    skipped: e.decisions ? undefined : e.skipped,
  };
}

function buildMechanical(
  events: EventRow[],
  v1: Awaited<ReturnType<typeof equityOf>>,
  v2: Awaited<ReturnType<typeof equityOf>>,
  pending: Awaited<ReturnType<typeof listPending>>,
  scores: ScoreItem[],
  spend: { cost: number; investigations: number },
  perfBlock: string,
  window: string,
  coverage: { sinceMs: number; nowMs: number; rowMs: number[]; basis: string },
): string {
  const investigated = events.filter((e) => e.decisions);
  const actions = investigated.flatMap((e) =>
    (e.decisions ?? []).map((d: any) => ({ e, d })),
  );
  const trades = actions.filter((a) => a.d.action !== "hold");
  const fills = events.flatMap((e) => e.executions.filter((x) => x.status === "filled" || x.pending_fill));
  const parked = events.flatMap((e) => e.executions.filter((x) => String(x.sk).includes("order-parked")));

  const out: string[] = [];
  const triaged = events.filter((e) => e.materiality !== undefined);
  const skipped = events.filter((e) => e.skipped && !e.decisions);
  const deduped = events.filter((e) => e.deduped);
  const suppressed = events.filter((e) => e.suppressed);
  const errored = investigated.filter(isErrored);
  const models = [...new Set(investigated.map((e) => e.model).filter((m): m is string => !!m))];

  out.push(perfBlock);
  out.push(`\n### Activity (${window})`);
  out.push(`window basis: ${coverage.basis}`);
  const equity = v2?.equity ?? 0;
  const spendBps = equity > 0 ? (spend.cost / equity) * 1e4 : 0;
  out.push(
    `news events triaged: ${triaged.length}; investigated: ${investigated.length}${errored.length > 0 ? ` (${errored.length} errored)` : ""}; actions: ${actions.length} (${trades.length} trades, ${fills.length} fills, ${parked.length} parked); LLM spend in this window: $${spend.cost.toFixed(2)} over ${spend.investigations} investigations = ${spendBps.toFixed(1)} bps of equity, $${(spend.investigations > 0 ? spend.cost / spend.investigations : 0).toFixed(2)} each (investigation cost only — Haiku triage is not metered)`,
  );
  out.push(
    `not investigated: ${skipped.length} material events skipped by the budget breaker; ${deduped.length} duplicate headlines dropped before triage; ${suppressed.filter((e) => e.suppressed!.kind !== "thin-book").length} position-watch alerts suppressed by the budget breaker; ${suppressed.filter((e) => e.suppressed!.kind === "thin-book").length} alerts on thin books judged not events (details under Coverage)`,
  );
  out.push(`agent model: ${models.join(", ") || "(not recorded on these rows)"}`);
  const proposals = investigated.filter((e) => e.proposals);
  if (proposals.length > 0) {
    const acc = proposals.reduce((n, e) => n + e.proposals!.accepted, 0);
    const rej = proposals.reduce((n, e) => n + e.proposals!.rejected, 0);
    const checks: Record<string, number> = {};
    for (const e of proposals) for (const [k, v] of Object.entries(e.proposals!.checks)) checks[k] = (checks[k] ?? 0) + v;
    const curiosity = investigated.filter((e) => e.curiosity);
    out.push(
      `world model (v3): ${acc} proposals accepted, ${rej} rejected by the gate (${Object.entries(checks).map(([k, v]) => `${k} ${v}`).join(", ")}); ${curiosity.length} curiosity-driven investigations, ${curiosity.filter((e) => e.executions.some((x: any) => x.status === "filled")).length} of them traded`,
    );
  }
  out.push(
    `\n### News flow (everything triaged in the window, most material first; * = touches a held position)`,
  );
  out.push(...newsFlowLines(triaged.map(toNewsFlowRow)));
  out.push(`\n### Investigations`);
  for (const e of investigated) {
    const modelTag = models.length > 1 && e.model ? `, model ${shortModel(e.model)}` : "";
    out.push(
      `- ${e.at.slice(5, 16)} [${e.trigger ?? "news"}${e.degraded ? ", degraded" : ""}${isErrored(e) ? ", ERRORED" : ""}${modelTag}] mat ${e.materiality ?? "-"}${e.touches ? "*" : ""} "${String(e.headline).slice(0, 90)}" (${e.turns} turns, $${(e.cost ?? 0).toFixed(2)})${e.proposals ? ` [world model +${e.proposals.accepted}/−${e.proposals.rejected}]` : ""}`,
    );
    for (const r of e.rejections ?? []) out.push(`    gate rejected: ${r}`);
    for (const d of e.decisions ?? []) {
      out.push(
        `    -> ${d.action}${d.symbol ? ` ${d.symbol}` : ""}${Number.isFinite(Number(d.notional_usd)) ? ` $${d.notional_usd}` : ""}${d.watch_symbol ? ` (watch ${d.watch_symbol})` : ""} conf ${d.confidence}${d.limit_price ? ` limit ${d.limit_price}` : ""}`,
      );
    }
    for (const x of e.executions) {
      if (x.status === "filled")
        out.push(`    == FILLED ${x.fill?.side} ${x.fill?.qty} ${x.fill?.symbol} @ ${x.fill?.fillPrice}${x.slice ? ` (slice of a working exit, $${x.remaining_usd ?? "?"} still working)` : x.pending_fill ? " (deferred)" : ""}`);
      else if (x.outcome?.status === "partial")
        out.push(`    == WORKING remainder ${x.order?.side} ${x.order?.symbol} $${x.order?.notional_usd} of $${x.outcome?.requested_usd} (liquidity_capped: book $${x.outcome?.book_usd}; one 25% slice per hour until filled or expired)`);
      else if (String(x.sk).includes("order-parked")) out.push(`    == PARKED (${x.outcome?.reason ?? x.order?.parked_reason})`);
      else if (x.status === "dropped") out.push(`    == dropped: ${x.reason}`);
      else if (String(x.sk).includes("settlement")) out.push(`    == SETTLED payout $${x.payout}`);
    }
  }
  out.push(`\n### Coverage (when the agent was NOT looking)`);
  out.push(...coverageLines(events, coverage));
  out.push(`\n### Book`);
  out.push(`v2: cash $${v2?.cash.toFixed(0)}, EQUITY $${v2?.equity.toFixed(0)}`);
  for (let i = 0; i < (v2?.positions ?? []).length; i++) {
    const row = v2!.rows[i];
    const weight = equity > 0 && row ? ((row.qty * row.mark) / equity) * 100 : 0;
    out.push(`  ${v2!.positions[i]}; position = ${weight.toFixed(1)}% of equity`);
  }
  out.push(`pending orders: ${pending.length}`);
  for (const o of pending)
    out.push(
      `  ${o.side} ${o.symbol} $${o.notional_usd}${o.limit_price ? ` limit ${o.limit_price}` : ""} (${o.parked_reason}${o.reduce_only ? `; WORKING exit: $${o.filled_usd ?? 0} of $${o.requested_usd ?? o.notional_usd} done, next slice after ${o.not_before}` : ""}, expires ${o.expires_at})`,
    );
  const corrections = events.flatMap((e) => e.corrections ?? []);
  if (corrections.length > 0) {
    const total = corrections.reduce((sum, c) => sum + c.unrealized_removed_usd, 0);
    out.push(
      `book corrections in window (administrative reversals AT COST of rule-violating fills — not trades, not decisions): ${corrections.length}; together they removed ${total >= 0 ? "+" : ""}$${total.toFixed(0)} of unrealized P&L, so equity moved by ${-total >= 0 ? "+" : ""}$${(-total).toFixed(0)} with no market event`,
    );
    for (const c of corrections) {
      out.push(
        `  ${c.at.slice(5, 16)} reversed ${c.qty > 0 ? "long" : "short"} ${Math.abs(c.qty)} ${c.symbol} at cost ${c.avg_cost}; removed ${c.unrealized_removed_usd >= 0 ? "+" : ""}$${c.unrealized_removed_usd.toFixed(0)} of unrealized P&L — ${c.reason}`,
      );
    }
  }
  out.push(
    PIPELINE_ARM
      ? `${PIPELINE_ARM.key} reference arm: EQUITY $${v1?.equity.toFixed(0)} (${v1?.positions.length} positions) — see Performance for basis`
      : `reference arm: none configured (arms.json has no pipeline arm) — there is no gated control book to compare against`,
  );
  out.push(`\n### Outcome scores to date`);
  out.push(scoreSummary(scores));
  return out.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient AWS failures once cost a whole day's letter: the 2026-09-01 18:00
 * scheduled run died on CredentialsProviderError (credential process mid-refresh) and nothing
 * retried, so the day had no letter until it was run by hand. Retry first.
 */
/**
 * Longest one narrative attempt may take. Normal is ~2 minutes; the slow
 * 2026-09-02 evening call would have finished inside this had it streamed.
 * Three attempts with backoff still land the 08:00 letter before 09:00.
 */
const NARRATIVE_DEADLINE_MS = 15 * 60_000;

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error(`[daily-report] ${label} attempt ${i}/${attempts} failed: ${why}`);
      if (i < attempts) await sleep(i * 60_000);
    }
  }
  throw lastErr;
}

async function narrative(
  mechanical: string,
  prevReports: string[],
  window: string,
  now: Date,
): Promise<{ text: string; ok: boolean; usage?: NormalizedUsage; cost_usd?: number }> {
  try {
    let attempt = 0;
    const resp = await withRetry("narrative", async () => {
      attempt++;
      // Fable 5.1's always-on thinking spends from max_tokens. 2000 truncated the
      // letter mid-sentence; 16000 was consumed ENTIRELY by thinking on 2026-09-05
      // (0 chars, stop_reason max_tokens) and an empty letter went to the printer.
      // Streamed, so a large ceiling costs nothing unless used. A retry after an
      // empty answer runs shallower.
      const effort = attempt > 1 ? "medium" : config.letterEffort;
      const msg = await streamMessage({
        model: config.masterModel,
        max_tokens: 64000,
        ...(effort ? { output_config: { effort } } : {}),
        system:
          "You write the daily letter for 'fin v2', an experimental autonomous news-reactive " +
          "paper-trading agent (Fable 5.1, no risk gate — the experiment measures its unassisted " +
          `judgment). You are given structured data covering ${window}, plus the ` +
          "previous letters. " +
          "Write as a portfolio manager reporting to the principal whose capital this is: " +
          "FLOWING PROSE meant to be printed and read — full paragraphs, no bullet lists, no " +
          "tables, section headings at most.\n\n" +
          "SHAPE OF THE LETTER, IN THIS ORDER.\n" +
          "1. THE CAPITAL. How much there is and how much of it is actually invested rather " +
          "than sitting in cash; what the return is, on what base, over what period; how that " +
          "compares with simply having held the market over the same window (the benchmark " +
          "lines are given to you — use them, and say plainly whether the agent added anything " +
          "over owning SPY or the theme it was trading); how much of the P&L is realized versus " +
          "a mark on positions that may not be sellable; and what the real cost of running the " +
          "agent is against a simulated P&L. Keep it tight — this is the opening, not the " +
          "letter.\n" +
          "2. THE TAPE. A quick, concrete overview of what happened in the world during the " +
          "window, the way a manager briefs a principal who has not read the news: the stories " +
          "of the period, what moved and why, in what order. Draw on the News flow section — " +
          "everything the agent triaged, including what it chose not to investigate and how the " +
          "flow broke down by type — and on the position alerts, which are the moves in the book " +
          "itself. The principal reads this part for the news; give it real space (names, " +
          "numbers, times) and keep it separate from your judgment of the agent.\n" +
          "3. WHAT THE AGENT DID about it and why: where its judgment and its execution were " +
          "good and where they were poor (name specific trades, sizes as a share of the book, " +
          "and prices); what it looked at and passed on, and whether passing was right. The note " +
          "on each News flow line is Haiku's TRIAGE rationale, written before any investigation " +
          "from the headline and item codes alone; the agent's own reasoning appears only under " +
          "Investigations. Never quote a triage note as the agent's reasoning, and never infer " +
          "from one what the agent could or could not read — on 2026-09-05 a letter did exactly " +
          "that and misreported eight filings the agent had read in full.\n" +
          "4. OUTCOME SCORES and how they are trending.\n" +
          "5. THE THREADS from previous letters: follow up on prior concerns, note what resolved " +
          "or worsened, and carry the running return story forward. Your own past criticisms " +
          "may already have been fixed in the code — the data is your only evidence, so do not " +
          "assume nothing was done.\n" +
          "6. WHAT YOU ARE WATCHING next.\n\n" +
          "RULES ON NUMBERS. Never state a dollar figure without the base it is a percentage " +
          "of, and never a percentage without saying what it is a percentage of. A gain is " +
          "meaningless without the capital that produced it and the time it took. Do not " +
          "annualize, and do not extrapolate from a handful of days or fills — say outright " +
          "when the sample is too small to distinguish skill from luck. Prefer return on " +
          "capital to raw dollars.\n\n" +
          (PIPELINE_ARM
            ? `FRAMING. This is NOT a contest with the ${PIPELINE_ARM.key} arm. ${PIPELINE_ARM.key} is a reference arm on the same ` +
              "news feed with a gated pipeline, useful only as context, and it has been running " +
              "over a different and longer window — say so rather than declaring a lead. Banish " +
              "scoreboard language: no 'we lead', 'we trail', 'the scoreboard flipped', no framing " +
              `the day as a win or loss against ${PIPELINE_ARM.key}. The subject is whether this capital is being ` +
              "managed well.\n\n"
            : "FRAMING. There is no reference arm configured, so there is nothing to compare against " +
              "and no scoreboard: the subject is whether this capital is being managed well.\n\n") +
          `TIME. This letter is being written on ${fmtLocalWeekday(now)} ${localZone(now)} and ` +
          `covers ${window}. The letterhead already states both, so do not add a dateline, ` +
          "title, or subtitle of your own — begin with the first section. The scheduled run is " +
          "08:00, so ordinarily most of what the data describes happened the day before and the " +
          "overnight session is its most recent part — but go by the timestamps, not by that " +
          'expectation. Do not call anything "today" or "yesterday": name the weekday and the ' +
          "time. The window " +
          "starts exactly where the previous letter's window ended, so nothing in this data " +
          "has been reported before — and nothing before the window start is new: follow the " +
          "previous letters' threads, do not re-narrate their trades as this period's. Data " +
          "timestamps are UTC (MM-DDTHH:MM); the window label is local time. Work weekdays " +
          "out from the dates given rather than guessing.\n\n" +
          "COVERAGE. The data's Coverage section is the only evidence of when the agent was " +
          "NOT looking: budget-suppressed position alerts, budget-skipped news, errored " +
          "investigations, and processing gaps where no rows of any kind were written " +
          "(worker offline). A quiet stretch in the investigation list is not a judgment the " +
          "agent made; check Coverage before attributing silence to it. Give an unwatched " +
          "stretch the weight it earned — a sentence if nothing happened meanwhile, a passage " +
          "of its own if the book or the news moved while nobody was looking — and say " +
          "plainly why it happened.\n\n" +
          "CORRECTIONS. A 'book corrections' line under Book is an administrative reversal, at " +
          "cost, of fills that violated the broker's own rules (they were filled before the " +
          "liquidity cap existed, at sizes no real book could absorb). It is not a trade and not " +
          "a decision by the agent, and the equity change it causes is not performance: report it " +
          "once, plainly, with the amount, and exclude it when judging how the period was managed. " +
          "Since-inception figures include its effect — say so when you quote them.\n\n" +
          "Be specific, honest, and readable aloud; no filler, no hedging boilerplate.",
        messages: [
          {
            role: "user",
            content: `## Previous reports (oldest first)\n${prevReports.join("\n\n---\n\n") || "(none — this is the first report)"}\n\n## Data for this letter (covering ${window})\n${mechanical}`,
          },
        ],
      }, { label: "daily-report narrative", deadlineMs: NARRATIVE_DEADLINE_MS });
      const text = msg.content
        .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
        .join("")
        .trim();
      if (!text) {
        const out = (msg as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? "?";
        throw new Error(
          `empty narrative (stop_reason=${msg.stop_reason}, ${out} output tokens${
            msg.stop_reason === "max_tokens" ? " — thinking consumed the whole budget" : ""
          })`,
        );
      }
      return msg;
    });
    // Priced at whatever model wrote the letter (pricing.ts), not a Fable-only constant.
    const priced = priceUsage(config.masterModel, normalizeUsage(resp.usage));
    const u = priced.usage;
    console.log(
      `[daily-report] narrative usage: ${u.input_tokens} in / ${u.output_tokens} out` +
        `${u.cache_read_input_tokens ? ` / ${u.cache_read_input_tokens} cache read` : ""}` +
        ` ≈ $${priced.usd.toFixed(2)} at ${config.masterModel} list rates` +
        `${priced.pricedWithFallback ? " (fallback rate: model not in pricing table; set V2_MODEL_RATES_JSON)" : ""}`,
    );
    if (resp.stop_reason === "max_tokens") {
      console.warn("[daily-report] narrative hit max_tokens — letter may be truncated");
    }
    return {
      text: resp.content
        .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : ""))
        .join("")
        .trim(),
      ok: true,
      usage: u,
      cost_usd: priced.usd,
    };
  } catch (e) {
    console.error("[daily-report] narrative failed, mechanical-only report:", e);
    return { text: "_narrative generation failed; see data appendix_", ok: false };
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const day = reportDay(now);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // The window begins where the previous letter's ended (see windowStart).
  const runs = await readReportRuns().catch((e) => {
    console.error("[daily-report] could not read previous runs, falling back:", e);
    return [] as ReportRun[];
  });
  const sameDay = runs.find((r) => r.day === day) ?? null;
  const previous = runs.filter((r) => r.day < day).at(-1) ?? null;
  const { sinceMs, basis } = windowStart({
    nowMs: now.getTime(),
    sameDayStartMs: sameDay ? Date.parse(sameDay.window_start) : null,
    previousGeneratedMs: previous ? Date.parse(previous.generated_at) : null,
    previousFileMs: previousReportMtimeMs(day),
  });
  const window = windowLabel(sinceMs, now);
  console.log(`[daily-report] window: ${window} (${basis})`);

  const noFills = { fills: 0, buyNotional: 0, realized: 0, firstAtIso: null as string | null };
  const [gathered, v1, v2, pending, pendingScores, doneScores] = await Promise.all([
    gatherEvents(sinceMs),
    PIPELINE_TABLE ? equityOf(PIPELINE_TABLE) : Promise.resolve(null),
    equityOf(config.table),
    listPending(),
    listScoreItems("P#"),
    listScoreItems("D#"),
  ]);
  const { events, rowMs } = gathered;
  const spend = windowSpend(events);

  // Performance basis: what was invested, what it returned, what the market did.
  const [v2Fills, v1Fills, spendToDate, storedInception] = await Promise.all([
    gatherFills(config.table),
    PIPELINE_TABLE ? gatherFills(PIPELINE_TABLE) : Promise.resolve(noFills),
    totalSpend(),
    readInception(config.table),
  ]);
  const seedCash = impliedSeed(v2?.cash ?? 0, v2?.rows ?? [], v2Fills.realized);
  // V2_INCEPTION > STATE/INCEPTION (seed.ts) > the first fill > now (an unseeded book).
  const inceptionIso = config.inceptionIso ?? storedInception ?? v2Fills.firstAtIso ?? now.toISOString();
  const perf = computePerf({
    seedCash,
    inceptionMs: Date.parse(inceptionIso),
    nowMs: now.getTime(),
    cash: v2?.cash ?? 0,
    positions: v2?.rows ?? [],
    realizedToDate: v2Fills.realized,
    buyNotionalToDate: v2Fills.buyNotional,
    fills: v2Fills.fills,
  });
  const benchmarks = await benchmarkReturns(Date.parse(inceptionIso));
  const priorSnapshots = await readSnapshots(config.arm);
  const prior = priorSnapshots.filter((x) => x.at < reportDay(now)).at(-1) ?? null;
  const reference =
    v1 && v1Fills.firstAtIso
      ? {
          equity: v1.equity,
          seedCash: impliedSeed(v1.cash, v1.rows, v1Fills.realized),
          inceptionIso: v1Fills.firstAtIso,
        }
      : null;
  const perfBlock = formatPerf(perf, seedCash, inceptionIso, benchmarks, spendToDate, prior, reference);

  // Record today's mark for this arm and the reference arm so later letters can compare like windows.
  await writeSnapshot(config.arm, day, perf.equity, v2?.cash ?? 0);
  if (v1 && PIPELINE_ARM) await writeSnapshot(PIPELINE_ARM.key, day, v1.equity, v1.cash);

  const mechanical = buildMechanical(
    events,
    v1,
    v2,
    pending,
    [...pendingScores, ...doneScores],
    spend,
    perfBlock,
    window,
    { sinceMs, nowMs: now.getTime(), rowMs, basis: BASIS_TEXT[basis] },
  );

  const prevFiles = fs
    .readdirSync(REPORTS_DIR)
    // Exclude today's own file so a rerun doesn't read itself as "yesterday".
    .filter((f) => f.endsWith(".md") && f !== `${day}.md`)
    .sort()
    .slice(-PREV_REPORTS);
  const prev = prevFiles.map((f, i) => {
    const body = fs.readFileSync(path.join(REPORTS_DIR, f), "utf8");
    // Narrative only; the appendix would blow up the context. The most recent
    // letter goes in WHOLE — its threads, scores and watch-list are what this
    // letter must continue. Older ones are cut to their opening. At 3000 chars
    // for all of them the model saw only each letter's capital section and wrote
    // "the previous two letters were truncated before their score sections".
    const narrative = body.split("## Data appendix")[0];
    const whole = i === prevFiles.length - 1;
    return `### ${f}${whole ? "" : " (opening only)"}\n${whole ? narrative : narrative.slice(0, PREV_TRUNCATE)}`;
  });

  const story = await narrative(mechanical, prev, window, now);
  const subtitle = `Covering ${window}.`;
  const narrativeOnly = normalizeHeadings(stripLeadingTitle(story.text));
  const report = `# ${config.prefix} ${config.arm} daily letter — ${day}\n\n_${subtitle}_\n\n${narrativeOnly}\n\n---\n\n## Data appendix\n\n${mechanical}\n`;
  const file = path.join(REPORTS_DIR, `${day}.md`);
  fs.writeFileSync(file, report);
  console.log(report);
  console.log(`\n[daily-report] written to ${file}`);

  // Advance the anchor only for a real letter: a failed narrative leaves the
  // period for the next run to tell, and a REPORT_DAY regeneration of an old
  // day must not move tomorrow's window.
  if (story.ok && !process.env.REPORT_DAY) {
    await writeReportRun({
      day,
      generated_at: now.toISOString(),
      window_start: sameDay?.window_start ?? new Date(sinceMs).toISOString(),
      // The letter's own LLM spend is not in the SPEND series; keep it on the anchor row.
      ...(story.usage
        ? { narrative_usage: story.usage, narrative_cost_usd: story.cost_usd ?? 0, narrative_model: config.masterModel }
        : {}),
    }).catch((e) => console.error("[daily-report] could not record run anchor:", e));
  }

  // Printable Word copy alongside the markdown (which stays the memory chain).
  const docx = path.join(REPORTS_DIR, `${day}.docx`);
  try {
    execFileSync("pandoc", [file, "-o", docx], {
      // Extra tool directories (pandoc, weasyprint) come from the operator: V2_TOOL_PATH, else HOMEBREW_PREFIX/bin when set.
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}${process.env.V2_TOOL_PATH ? `:${process.env.V2_TOOL_PATH}` : process.env.HOMEBREW_PREFIX ? `:${process.env.HOMEBREW_PREFIX}/bin` : ""}` },
    });
    console.log(`[daily-report] Word copy: ${docx}`);
  } catch (e) {
    console.error("[daily-report] pandoc docx conversion failed:", e);
  }

  // Narrative-only PDF: the letter as a person reads it, without the appendix.
  // Rendering always happens; PRINTING is opt-in (V2_PRINT=1, set in the launchd
  // plist) so that regenerating a letter by hand never hits the paper tray.
  // Neither step may take down the report — the markdown is the real artifact.
  const pdf = path.join(REPORTS_DIR, `${day}.pdf`);
  try {
    renderNarrativePdf(`${config.prefix} ${config.arm} daily letter — ${day}`, subtitle, narrativeOnly, pdf);
    console.log(`[daily-report] printable letter: ${pdf}`);
    if ((process.env.V2_PRINT ?? "").toLowerCase() === "1") {
      console.log(`[daily-report] ${printPdf(pdf, process.env.V2_PRINTER)}`);
    }
  } catch (e) {
    console.error("[daily-report] printable letter failed:", e);
  }
}

// Entry point only when run directly: importing this module must never kick
// off a live report run (AWS reads + Fable spend).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  withRetry("report", main).catch((e) => {
    console.error("[daily-report] fatal:", e);
    process.exit(1);
  });
}
