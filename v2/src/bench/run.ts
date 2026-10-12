// SPDX-License-Identifier: MIT-0
import { config } from "../config.js";
import { HORIZONS } from "../score.js";
import { SimBook, type SimOutcome } from "./book.js";
import { fillPrice } from "../exec.js";
import type { Strategy } from "../strategy.js";
import type { BookView } from "../tools.js";
import type { WatchIdea } from "../mandate.js";
import type { ThesisEntry } from "../thesis.js";
import type { InstrumentKind, NewsItem, Quote, Resolution, TradeDecision } from "../types.js";

export type { BookView };

/**
 * The variant runner: one Strategy, one chronological pass over a window of
 * triaged events, one simulated book that carries across them. replay.ts is
 * the CLI shell (EventBridge replay, SQS drain, triage, persistence); this
 * module is the loop, with every side effect injected so it is testable
 * without AWS or the Agent SDK.
 *
 * What the strategy sees at each event is exactly what the live agent would
 * have seen at that moment: the book as it stood, the mandate against that
 * book, a watchlist of the instruments its own earlier holds named, and — via
 * toolOptions — an as-of resolver and this run's own decision history. The
 * live THESIS# table is never consulted: it holds rationales written after
 * the event, which is lookahead.
 */

export interface BenchEvent {
  item: NewsItem;
  hypotheses: string[];
  materiality: number;
  /** Cleared the triage threshold under test. */
  passed: boolean;
  /** Triage event type and held-symbol flag, for variants that apply their own admission rule. */
  eventType?: string;
  touchesPositions?: boolean;
}

export interface BenchRow {
  news_id: string;
  headline: string;
  materiality: number;
  variant: string;
  /** The PRIMARY action: first trade, else the hold. Undefined when not investigated or errored. */
  action?: string;
  symbol?: string;
  confidence?: number;
  cost_usd: number;
  ret_1d?: number | null;
  ret_7d?: number | null;
  scoreable?: boolean;
  /** Set when the variant's own admission rule (Strategy.admit) declined the event. */
  skipped?: string;
  /** Investigated by the variant's own rule although the flat bar under test did not pass it. */
  belowBar?: boolean;
  errored?: boolean;
  /** The Bedrock guardrail blocked a call in this run (the `guardrail` variant). */
  guardrail_intervened?: boolean;
  /** The primary action's fill on the sim book, null when it was a hold or was dropped. */
  fill?: { side: "buy" | "sell"; qty: number; fillPrice: number; notionalUsd: number } | null;
  /** Why the primary action did not fill (SimBook drop reason or "unresolvable"). */
  dropped?: string | null;
  /** The order parked at event time (venue closed / limit) and is due to fill at this instant. */
  parked_until?: string | null;
  /** When a parked order actually filled (for a working exit: its last slice). */
  filled_at?: string | null;
  /** Slices of a liquidity-capped reduction filled after the first; `fill` accumulates them. */
  slices?: number;
  num_actions?: number;
}

export interface RunDeps {
  resolveAsOf: (symbol: string, kind: InstrumentKind | "auto", asOfMs: number) => Promise<Resolution>;
  historicalReturn: (
    symbol: string,
    kind: InstrumentKind | "auto",
    action: "buy" | "sell" | "hold",
    entryMs: number,
    horizonMs: number,
  ) => Promise<{ entry: number; exit: number; ret: number } | null>;
  /** Audit sink; the caller decides the pk prefix (replay.ts uses BENCH#). */
  audit?: (id: string, stage: string, payload: unknown) => Promise<void>;
  addSpend?: (usd: number) => Promise<void>;
  nowMs?: number;
  log?: (line: string) => void;
}

export interface RunOptions {
  benchName: string;
  seedCash: number;
  maxInvestigations: number;
  /** Per-variant spend ceiling (never the live breaker). */
  budgetUsd: number;
  /** The bench window's end; the book is marked at min(windowEnd, now). */
  windowEndMs: number;
}

/**
 * Live, the ledger refuses quotes older than config.maxQuoteAgeSecs. A historical
 * bar is at most its own span old by construction (its close is known at its
 * end), so the bench bound is the larger of the two: hourly granularity on a
 * 24x7 venue is not a closed market. A venue that IS closed at event time still
 * fails this bound (the last completed bar is hours old) and the order parks.
 */
export function fillBound(meta: { barSpanSecs?: number }): number {
  return Math.max(config.maxQuoteAgeSecs, meta.barSpanSecs ?? 0);
}

/** Live, the watcher retries parked orders every 5 min; the bench steps through history at this pace. */
export const PARK_STEP_MS = 30 * 60_000;

/** Same set as pending.ts PARKABLE_REASONS (not imported: pending.ts constructs AWS clients). */
const PARKABLE = new Set(["dropped_stale_quote", "limit_not_met"]);

interface Parked {
  d: TradeDecision & { action: "buy" | "sell" };
  actionId: string;
  row: BenchRow;
  isPrimary: boolean;
  fillAtMs: number;
  /** The original order's expiry; slices of a working exit inherit it. */
  expiresMs: number;
  /** A slice of a liquidity-capped reduction (mirror of pending.ts remainders). */
  slice?: boolean;
}

/** Does a fill on this side shrink the position held before it? (mirror of pending.isReduction) */
function isReduction(side: "buy" | "sell", positionBefore: number): boolean {
  return side === "sell" ? positionBefore > 0 : positionBefore < 0;
}

function afterFill(o: Extract<SimOutcome, { status: "filled" }>): number {
  return o.positionBefore + (o.fill.side === "buy" ? o.fill.qty : -o.fill.qty);
}

/**
 * The working remainder of a liquidity-capped reduction, or null when what is
 * left is dust or the position is gone. Mirror of pending.remainderAfter
 * (pending.ts constructs AWS clients, so it is not imported here).
 */
export function sliceRemainder(
  order: TradeDecision & { action: "buy" | "sell" },
  filledUsd: number,
  positionAfter: number,
): (TradeDecision & { action: "buy" | "sell" }) | null {
  const remaining = Math.round(((order.notional_usd ?? 0) - filledUsd) * 100) / 100;
  if (remaining < 1) return null;
  if (!isReduction(order.action, positionAfter)) return null;
  return { ...order, notional_usd: remaining, reduce_only: true };
}

/**
 * The first moment after `fromMs` (stepping PARK_STEP_MS, not past `untilMs`) at
 * which the instrument has a quote fresh enough to fill and, when the agent set
 * a limit, a fill price that honours it. Null when none exists before expiry.
 */
export async function firstFillableMs(
  d: TradeDecision & { action: "buy" | "sell" },
  fromMs: number,
  untilMs: number,
  deps: Pick<RunDeps, "resolveAsOf">,
): Promise<number | null> {
  for (let t = fromMs + PARK_STEP_MS; t <= untilMs; t += PARK_STEP_MS) {
    const r = await deps.resolveAsOf(d.symbol!, d.kind ?? "auto", t).catch(() => null);
    if (!r || !r.ok) continue;
    if (r.meta.ageSecs > fillBound(r.meta)) continue;
    if (d.limit_price !== undefined) {
      const calc = fillPrice(r.quote, d.action);
      if (!calc) continue;
      const violated = d.action === "buy" ? calc.fillPrice > d.limit_price : calc.fillPrice < d.limit_price;
      if (violated) continue;
    }
    return t;
  }
  return null;
}

export interface VariantRun {
  variant: string;
  description: string;
  rows: BenchRow[];
  /** Investigations that produced a decision (runtime-errored runs are not decisions). */
  investigations: number;
  errored: number;
  /** Events a variant's own admission rule declined (0 unless the variant defines one). */
  skipped_by_variant: number;
  /** Events a variant's own rule investigated although they were under the flat bar (0 unless it defines one). */
  admitted_below_bar: number;
  /** Orders still parked when the window closed (never filled, never expired). */
  parked: number;
  cost_usd: number;
  book: {
    seed_cash: number;
    final_equity: number;
    return_on_seed: number;
    realized_pnl: number;
    fills: number;
    open_positions: Array<{ symbol: string; kind: string; qty: number; avg_cost: number; mark: number }>;
  };
  stopped_reason?: "max" | "budget" | null;
}

/** One investigation's outcome, kept so later events can see what this run already thought. */
export interface Adjudication {
  atMs: number;
  headline: string;
  decisions: TradeDecision[];
}

// Same compaction thesis.ts applies to the durable copy.
const LATEST_RATIONALE_MAX = 600;
const HISTORY_RATIONALE_MAX = 200;
const HISTORY_MAX = 8;

function eventMs(ev: BenchEvent): number {
  return Date.parse(ev.item.published_at);
}

/**
 * Prior holds' watch_symbol within the mandate window, newest first, one per
 * symbol — what recent.ts recordInvestigation()/watchlist() do live.
 */
export function watchlistFrom(
  adjudications: Adjudication[],
  nowMs: number,
  windowMs = config.mandate.watchlistHours * 3_600_000,
): WatchIdea[] {
  const seen = new Set<string>();
  const out: WatchIdea[] = [];
  const sorted = [...adjudications].sort((a, b) => b.atMs - a.atMs);
  for (const adj of sorted) {
    if (nowMs - adj.atMs > windowMs) continue;
    for (const d of adj.decisions) {
      if (d.action !== "hold" || !d.watch_symbol) continue;
      if (seen.has(d.watch_symbol)) continue;
      seen.add(d.watch_symbol);
      out.push({
        symbol: d.watch_symbol,
        at: new Date(adj.atMs).toISOString(),
        headline: adj.headline.slice(0, 120),
        rationale: d.rationale ?? "",
        confidence: d.confidence,
      });
    }
  }
  return out;
}

/** Newest-first per symbol, like thesis.ts (latest + up to 8 compacted history entries). */
export function pushThesis(theses: Map<string, ThesisEntry[]>, symbol: string, entry: ThesisEntry): void {
  const list = theses.get(symbol) ?? [];
  list.unshift(entry);
  theses.set(symbol, list.slice(0, HISTORY_MAX + 1));
}

function thesisFor(theses: Map<string, ThesisEntry[]>, symbol: string) {
  const list = theses.get(symbol);
  if (!list || list.length === 0) return null;
  const [latest, ...history] = list;
  return {
    symbol,
    latest: { ...latest, rationale: latest.rationale.slice(0, LATEST_RATIONALE_MAX) },
    history: history.map((e) => ({ ...e, rationale: e.rationale.slice(0, HISTORY_RATIONALE_MAX) })),
  };
}

/** The sim book behind the portfolio/decision-history tools. */
export function simBookView(book: SimBook, theses: Map<string, ThesisEntry[]>): BookView {
  return {
    async getPortfolio() {
      return {
        cash: book.cash,
        realized_pnl_today: book.realizedPnl,
        day_key: new Date(book.nowMs).toISOString().slice(0, 10),
      };
    },
    async listPositions() {
      return book.positions.map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        avg_cost: p.avg_cost,
        kind: p.kind,
        ...(p.last_seen_price !== undefined ? { last_watch_price: p.last_seen_price } : {}),
      }));
    },
    async recentTrades(symbol, limit) {
      return book.fills
        .filter((f) => f.symbol === symbol)
        .reverse()
        .slice(0, limit)
        .map((f) => ({
          decisionId: f.decisionId,
          symbol: f.symbol,
          kind: f.kind,
          side: f.side,
          qty: f.qty,
          quotePrice: f.quotePrice,
          fillPrice: f.fillPrice,
          slippageBps: f.slippageBps,
          notionalUsd: f.notionalUsd,
          realizedPnl: f.realizedPnl,
          quoteSource: "sim-book",
          filledAt: new Date(f.atMs).toISOString(),
        }));
    },
    async decisionHistory(symbol) {
      return thesisFor(theses, symbol);
    },
  };
}

/** Re-mark every held position as of `atMs`; a symbol that will not resolve keeps its last mark. */
async function markBook(book: SimBook, atMs: number, deps: RunDeps): Promise<void> {
  const positions = book.positions;
  if (positions.length === 0) return;
  const quotes: Record<string, Quote> = {};
  await Promise.all(
    positions.map(async (p) => {
      try {
        const r = await deps.resolveAsOf(p.symbol, (p.kind as InstrumentKind) ?? "auto", atMs);
        if (r.ok) quotes[p.symbol] = r.quote;
      } catch {
        // keep the previous mark
      }
    }),
  );
  book.mark(quotes);
}

export async function runVariant(
  strategy: Strategy,
  events: BenchEvent[],
  opts: RunOptions,
  deps: RunDeps,
): Promise<VariantRun> {
  const log = deps.log ?? (() => {});
  const nowMs = deps.nowMs ?? Date.now();
  // A book path must be chronological whatever order the archive delivered.
  const sorted = [...events].sort((a, b) => eventMs(a) - eventMs(b));
  const startMs = sorted.length > 0 ? eventMs(sorted[0]) : Math.min(opts.windowEndMs, nowMs);
  const book = new SimBook({ cash: opts.seedCash, nowMs: startMs });
  const theses = new Map<string, ThesisEntry[]>();
  const view = simBookView(book, theses);
  const adjudications: Adjudication[] = [];
  const rows: BenchRow[] = [];
  const pending: Parked[] = [];

  // Mirror of the live watcher's working exits: the remainder of a capped
  // reduction is retried one slice per config.pendingSliceMinutes until it
  // fills, the position is gone, or the original order expires.
  async function parkSlice(p: Omit<Parked, "fillAtMs" | "slice">, afterMs: number): Promise<void> {
    const sliceMs = config.pendingSliceMinutes * 60_000;
    const fromMs = Math.max(afterMs, afterMs + sliceMs - PARK_STEP_MS);
    const fillAtMs = await firstFillableMs(p.d, fromMs, p.expiresMs, deps);
    if (fillAtMs === null) {
      log(`[bench:${strategy.name}]   working ${p.d.action} ${p.d.symbol} $${p.d.notional_usd}: no fillable slice before expiry`);
      return;
    }
    pending.push({ ...p, fillAtMs, slice: true });
  }

  // Fill every parked order whose moment has come, in order, before the book
  // moves on — so a fill at 14:30 lands before an event at 15:00 is decided.
  // A loop rather than a snapshot: a slice that fills may park the next one
  // inside the same span.
  async function settlePending(uptoMs: number): Promise<void> {
    for (;;) {
      const due = pending.filter((p) => p.fillAtMs <= uptoMs).sort((a, b) => a.fillAtMs - b.fillAtMs);
      if (due.length === 0) break;
      const p = due[0];
      pending.splice(pending.indexOf(p), 1);
      book.setClock(p.fillAtMs);
      const r = await deps.resolveAsOf(p.d.symbol!, p.d.kind ?? "auto", p.fillAtMs);
      const o = r.ok
        ? book.apply(p.d, r.quote, p.actionId, { maxQuoteAgeSecs: fillBound(r.meta) })
        : ({ status: "dropped", reason: "unresolvable", detail: r.reason } as const);
      if (p.isPrimary) {
        if (o.status === "filled") {
          // Slices accumulate onto the row's fill: total qty, total notional, average price.
          const prev = p.slice ? p.row.fill : null;
          const qty = (prev?.qty ?? 0) + o.fill.qty;
          const notionalUsd = (prev?.notionalUsd ?? 0) + o.fill.notionalUsd;
          p.row.fill = { side: o.fill.side, qty, fillPrice: prev && qty > 0 ? notionalUsd / qty : o.fill.fillPrice, notionalUsd };
          p.row.dropped = null;
          p.row.filled_at = new Date(p.fillAtMs).toISOString();
          if (p.slice) p.row.slices = (p.row.slices ?? 0) + 1;
        } else if (!p.slice) {
          p.row.fill = null;
          p.row.dropped = o.reason;
        }
        // A slice that cannot fill (position gone) leaves the earlier fills on the row.
      }
      log(
        `[bench:${strategy.name}]   ${p.slice ? "slice" : "parked"} ${p.d.action} ${p.d.symbol} ` +
          (o.status === "filled" ? `FILLED ${o.fill.qty} @ ${o.fill.fillPrice}` : `dropped:${o.reason}`) +
          ` at ${new Date(p.fillAtMs).toISOString()}`,
      );
      if (o.status === "filled" && o.fill.liquidityCapped && isReduction(o.fill.side, o.positionBefore)) {
        const rest = sliceRemainder(p.d, o.fill.notionalUsd, afterFill(o));
        if (rest) {
          await parkSlice({ d: rest, actionId: p.actionId, row: p.row, isPrimary: p.isPrimary, expiresMs: p.expiresMs }, p.fillAtMs);
        }
      }
    }
  }

  let investigations = 0;
  let errored = 0;
  let spent = 0;
  let stopped: "max" | "budget" | null = null;

  for (const ev of sorted) {
    const atMs = eventMs(ev);
    const row: BenchRow = {
      news_id: ev.item.id,
      headline: ev.item.headline.slice(0, 120),
      materiality: ev.materiality,
      variant: strategy.name,
      cost_usd: 0,
    };
    // Admission. A variant with its own rule owns it entirely — it may decline an
    // event the flat bar passed (recorded as `skipped`) or take one the flat bar
    // did not (recorded as `belowBar`), which is how a moving-bar filter gets a
    // fair test against `live` on the same tape. Without a rule the flat bar rules.
    const admission = strategy.admit ? strategy.admit(ev) : null;
    const eligible = admission ? admission.admitted : ev.passed;
    if (!eligible || stopped) {
      if (admission && !admission.admitted && ev.passed && !stopped) {
        row.skipped = admission.reason;
        log(`[bench:${strategy.name}] skipped by variant: ${admission.reason} — ${row.headline}`);
      }
      rows.push(row);
      continue;
    }
    if (admission && !ev.passed) row.belowBar = true;
    if (investigations >= opts.maxInvestigations) {
      stopped = "max";
      log(`[bench:${strategy.name}] stopping: ${opts.maxInvestigations} investigations`);
      rows.push(row);
      continue;
    }
    if (!(spent < opts.budgetUsd)) {
      stopped = "budget";
      log(`[bench:${strategy.name}] stopping: bench budget $${opts.budgetUsd} spent`);
      rows.push(row);
      continue;
    }

    await settlePending(atMs);
    book.setClock(atMs);
    await markBook(book, atMs, deps);
    const bookContext = book.renderContext(watchlistFrom(adjudications, atMs));

    const res = await strategy.decide({
      item: ev.item,
      hypotheses: ev.hypotheses,
      bookContext,
      nowIso: ev.item.published_at,
      bench: true,
      transcriptId: `bench/${opts.benchName}/${strategy.name}/${ev.item.id}`,
      toolOptions: { asOfMs: atMs, book: view },
    });
    spent += res.costUsd;
    row.cost_usd = res.costUsd;
    row.errored = res.errored;
    if (res.guardrailIntervened) row.guardrail_intervened = true;
    if (deps.addSpend && res.costUsd > 0) await deps.addSpend(res.costUsd);

    const auditId = `${opts.benchName}#${strategy.name}#${ev.item.id}`;
    if (res.errored) {
      // The runtime failed before the agent answered: cost was spent, nothing was decided.
      errored++;
      rows.push(row);
      await deps.audit?.(auditId, "bench-decision", {
        variant: strategy.name,
        errored: true,
        cost_usd: res.costUsd,
        num_turns: res.numTurns,
        transcript: res.transcriptUri,
        headline: ev.item.headline,
      });
      log(`[bench:${strategy.name}] ERRORED ($${res.costUsd.toFixed(2)}) ${row.headline}`);
      continue;
    }
    investigations++;

    const n = res.decisions.length;
    const primary = res.decisions.find((d) => d.action !== "hold") ?? res.decisions[0];
    row.action = primary.action;
    row.confidence = primary.confidence;
    row.symbol = primary.symbol ?? primary.watch_symbol;
    row.num_actions = n;

    const outcomes: unknown[] = [];
    let primaryOutcome: { fill?: BenchRow["fill"]; dropped?: string | null; parked_until?: string | null } = {};
    for (let i = 0; i < n; i++) {
      const d = res.decisions[i];
      const actionId = n === 1 ? ev.item.id : `${ev.item.id}#${i + 1}`;
      // This run's own memory: what get_decision_history returns to later events.
      for (const sym of new Set([d.symbol, d.watch_symbol].filter((s): s is string => !!s))) {
        pushThesis(theses, sym, {
          at: ev.item.published_at,
          action: d.action,
          confidence: d.confidence,
          trigger: ev.item.source_family,
          rationale: d.rationale,
        });
      }
      if (d.action === "hold") {
        outcomes.push({ action_id: actionId, action: "hold", watch_symbol: d.watch_symbol ?? null });
        continue;
      }
      const r = await deps.resolveAsOf(d.symbol!, d.kind ?? "auto", atMs);
      let outcome: unknown;
      if (!r.ok) {
        outcome = { status: "dropped", reason: "unresolvable", detail: r.reason };
        if (d === primary) primaryOutcome = { fill: null, dropped: "unresolvable" };
      } else {
        const order = d as TradeDecision & { action: "buy" | "sell" };
        // A fresh decision on a symbol supersedes any order parked for it (live: cancelPending).
        for (let j = pending.length - 1; j >= 0; j--) if (pending[j].d.symbol === order.symbol) pending.splice(j, 1);
        let o: SimOutcome | { status: "parked"; reason: string; fill_at: string } = book.apply(
          order,
          r.quote,
          actionId,
          { maxQuoteAgeSecs: fillBound(r.meta) },
        );
        if (o.status === "dropped" && PARKABLE.has(o.reason)) {
          // Venue closed at event time (an 8-K at 01:00 UTC) or limit not met: live,
          // the order parks and retries until expiry. Step forward to the first
          // fillable moment; it fills when the book's clock reaches it.
          const untilMs = Math.min(atMs + config.pendingExpiryHours * 3_600_000, nowMs);
          const fillAtMs = await firstFillableMs(order, atMs, untilMs, deps);
          if (fillAtMs !== null) {
            pending.push({ d: order, actionId, row, isPrimary: d === primary, fillAtMs, expiresMs: untilMs });
            o = { status: "parked", reason: o.reason, fill_at: new Date(fillAtMs).toISOString() };
          } else {
            o = {
              status: "dropped",
              reason: "expired_pending",
              detail: `${o.reason}; no fillable quote within ${config.pendingExpiryHours}h`,
            };
          }
        }
        // A capped fill that reduces a position keeps the rest working (live: pending.ts).
        if (o.status === "filled" && o.fill.liquidityCapped && isReduction(o.fill.side, o.positionBefore)) {
          const rest = sliceRemainder(order, o.fill.notionalUsd, afterFill(o));
          if (rest) {
            const expiresMs = Math.min(atMs + config.pendingExpiryHours * 3_600_000, nowMs);
            await parkSlice({ d: rest, actionId, row, isPrimary: d === primary, expiresMs }, atMs);
          }
        }
        outcome = o;
        if (d === primary) {
          primaryOutcome =
            o.status === "filled"
              ? {
                  fill: {
                    side: o.fill.side,
                    qty: o.fill.qty,
                    fillPrice: o.fill.fillPrice,
                    notionalUsd: o.fill.notionalUsd,
                  },
                  dropped: null,
                }
              : o.status === "parked"
                ? { fill: null, dropped: null, parked_until: o.fill_at }
                : { fill: null, dropped: o.reason };
        }
      }
      outcomes.push({ action_id: actionId, action: d.action, symbol: d.symbol, notional_usd: d.notional_usd, ...(outcome as object) });
    }
    row.fill = primaryOutcome.fill ?? null;
    row.dropped = primaryOutcome.dropped ?? null;
    row.parked_until = primaryOutcome.parked_until ?? null;

    if (row.symbol) {
      const kind = primary.kind ?? primary.watch_kind ?? "auto";
      const [r1, r7] = await Promise.all([
        deps.historicalReturn(row.symbol, kind, primary.action, atMs, HORIZONS["1d"]).catch(() => null),
        deps.historicalReturn(row.symbol, kind, primary.action, atMs, HORIZONS["7d"]).catch(() => null),
      ]);
      row.ret_1d = r1?.ret ?? null;
      row.ret_7d = r7?.ret ?? null;
      row.scoreable = !(r1 === null && r7 === null);
    }

    adjudications.push({ atMs, headline: ev.item.headline, decisions: res.decisions });
    await deps.audit?.(auditId, "bench-decision", {
      variant: strategy.name,
      decisions: res.decisions,
      outcomes,
      cost_usd: res.costUsd,
      num_turns: res.numTurns,
      transcript: res.transcriptUri,
      ret_1d: row.ret_1d ?? null,
      ret_7d: row.ret_7d ?? null,
      scoreable: row.scoreable ?? null,
      errored: false,
      ...(res.guardrailIntervened ? { guardrail_intervened: true } : {}),
      headline: ev.item.headline,
      book_after: book.snapshot(),
      equity_after: book.equity(),
    });
    rows.push(row);
    log(
      `[bench:${strategy.name}] ${investigations}/${opts.maxInvestigations} ${row.action} ${row.symbol ?? ""}` +
        (row.fill
          ? ` FILLED ${row.fill.side} ${row.fill.qty} @ ${row.fill.fillPrice}`
          : row.parked_until
            ? ` PARKED until ${row.parked_until}`
            : row.dropped
              ? ` dropped:${row.dropped}`
              : "") +
        ` (mat ${row.materiality}, $${res.costUsd.toFixed(2)}) ${row.headline}`,
    );
  }

  // Close the books: mark everything at the window's end (or now, if the window is still open).
  const endMs = Math.min(opts.windowEndMs, nowMs);
  await settlePending(Math.max(endMs, book.nowMs));
  book.setClock(Math.max(endMs, book.nowMs));
  await markBook(book, book.nowMs, deps);
  const finalEquity = book.equity();

  return {
    variant: strategy.name,
    description: strategy.description,
    rows,
    investigations,
    errored,
    skipped_by_variant: rows.filter((r) => r.skipped).length,
    admitted_below_bar: rows.filter((r) => r.belowBar).length,
    parked: pending.length,
    cost_usd: spent,
    book: {
      seed_cash: opts.seedCash,
      final_equity: finalEquity,
      return_on_seed: opts.seedCash > 0 ? finalEquity / opts.seedCash - 1 : 0,
      realized_pnl: book.realizedPnl,
      fills: book.fills.length,
      open_positions: book.positions.map((p) => ({
        symbol: p.symbol,
        kind: p.kind,
        qty: p.qty,
        avg_cost: p.avg_cost,
        mark: p.last_seen_price ?? p.avg_cost,
      })),
    },
    stopped_reason: stopped,
  };
}
