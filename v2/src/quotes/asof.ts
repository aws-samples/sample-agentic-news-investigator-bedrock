// SPDX-License-Identifier: MIT-0
import type { InstrumentKind, Quote, Resolution } from "../types.js";
import { inferKind, isLiquidFxPair } from "./resolver.js";
import { splitSide } from "./prediction.js";
import { intervalForAge, yahooBars, type Bar } from "./yahoo.js";
import { entryPrice, exitPrice, signedReturn } from "../score.js";

/**
 * As-of-event resolution for the replay bench. `resolve()` in resolver.ts is
 * LIVE: an archived event replayed through it is investigated against today's
 * book, so bench returns are contaminated (FLZH was "investigated" at a price
 * that already contained the collapse) and a week-old US equity event replayed
 * at 01:00 UTC looks like a closed venue. This module answers "what was the
 * quote at <moment>" from two immutable sources and nothing else:
 *
 *  1. the quote tape — every live quote the workers captured, injected as a
 *     function so this file has no dependency on tape.ts;
 *  2. Yahoo's historical bars (quotes/yahoo.ts `yahooBars`).
 *
 * It never falls through to a live quote: when neither source has a price at
 * or before the moment the instrument is Unresolved, and every age here is
 * measured against the as-of moment, not against now.
 *
 * Bars are used as the LAST COMPLETED bar. A bar's timestamp is its open, so
 * the close of the bar that contains the moment is the future — for a 1d bar
 * of a US equity, up to a whole session of it. A bar therefore counts only once
 * open + span <= asOf, and the quote's asOfMs is that open.
 *
 * Staleness is bounded by market closure, not by bar width: Friday's close to
 * Tuesday's open over a Monday holiday is ~89 hours on a venue that is very
 * much alive, so any quote (tape or bar) up to four days plus one bar span
 * before the moment is accepted, and anything older means the instrument has
 * stopped trading. Minute bars are fetched over one day (an overnight gap fits;
 * at most 1,440 bars) and fall through to hourly, then daily bars over the full
 * bound, so the answer does not depend on how old the event is at bench time.
 */

/** What the tape gives us (mirrors the tape's quote row; defined locally so this module has no dependency on tape.ts). */
export interface TapeQuoteLike {
  symbol: string;
  kind: InstrumentKind;
  price: number;
  bid?: number;
  ask?: number;
  asOfMs: number;
  source: string;
  liquidityUsd?: number;
  resolved?: boolean;
  hasBook: boolean;
  ageSecs: number;
  indicativeOnly: boolean;
  captured_at: string;
  note?: string;
}

export interface AsOfDeps {
  /** Nearest captured quote at or before asOfMs, or null. Injected (the tape); may be absent. */
  tape?: (symbol: string, asOfMs: number) => Promise<TapeQuoteLike | null>;
  /** Injected for tests; defaults to yahooBars. */
  bars?: typeof yahooBars;
  nowMs?: number;
}

type AsOfInterval = ReturnType<typeof intervalForAge>;

const DAY_MS = 86_400_000;
const LADDER: AsOfInterval[] = ["1m", "60m", "1d"];
const SPAN_MS: Record<AsOfInterval, number> = { "1m": 60_000, "60m": 3_600_000, "1d": DAY_MS };
/** Longest closure a still-trading venue has (weekend + holiday), rounded up. */
export const MAX_CLOSURE_MS = 4 * DAY_MS;
/** How far before the moment each interval is fetched. */
const LOOKBACK_MS: Record<AsOfInterval, number> = {
  "1m": DAY_MS,
  "60m": MAX_CLOSURE_MS + SPAN_MS["60m"],
  "1d": MAX_CLOSURE_MS + SPAN_MS["1d"],
};

/** The resolver upper-cases everything but prediction slugs before inferring a kind; mirror that. */
function canonical(symbol: string): string {
  const s = symbol.trim();
  return splitSide(s) ? s : s.toUpperCase();
}

/**
 * Internal symbol + kind -> Yahoo chart symbol. fx "EURUSD" -> "EURUSD=X";
 * crypto "BTC" -> "BTC-USD"; equity verbatim, which already covers futures
 * (CL=F) and exchange-suffixed listings (7203.T); parallel_fx and prediction
 * -> null (Yahoo has no history for either).
 */
export function yahooChartSymbol(symbol: string, kind?: InstrumentKind | "auto"): string | null {
  const s = canonical(symbol);
  const k: InstrumentKind = kind && kind !== "auto" ? kind : inferKind(s);
  switch (k) {
    case "fx":
      return `${s}=X`;
    case "crypto":
      return `${s}-USD`;
    case "equity":
      return s;
    default:
      return null;
  }
}

function ageSecs(asOfMs: number, quoteMs: number): number {
  return Math.max(0, Math.round((asOfMs - quoteMs) / 1000));
}

function fromTape(row: TapeQuoteLike, asOfMs: number): Resolution {
  const quote: Quote = {
    symbol: row.symbol,
    kind: row.kind,
    price: row.price,
    asOfMs: row.asOfMs,
    source: row.source,
    ...(row.bid !== undefined ? { bid: row.bid } : {}),
    ...(row.ask !== undefined ? { ask: row.ask } : {}),
    ...(row.liquidityUsd !== undefined ? { liquidityUsd: row.liquidityUsd } : {}),
    ...(row.resolved !== undefined ? { resolved: row.resolved } : {}),
  };
  const note =
    `live quote captured on the tape at ${row.captured_at}` + (row.note ? `; ${row.note}` : "");
  return {
    ok: true,
    quote,
    meta: {
      hasBook: row.hasBook,
      ageSecs: ageSecs(asOfMs, row.asOfMs),
      indicativeOnly: row.indicativeOnly,
      note,
    },
  };
}

function fromBar(
  symbol: string,
  kind: InstrumentKind,
  bar: Bar,
  interval: AsOfInterval,
  asOfMs: number,
): Resolution {
  // The close is only known when the bar ends, so that is the moment the price
  // is "as of". Stamping the open would make a 60m bar look an hour older than
  // the information it carries and fail the 20-min staleness gate on a 24x7 venue.
  const span = SPAN_MS[interval];
  const closeMs = bar.tMs + span;
  const quote: Quote = {
    symbol,
    kind,
    price: bar.close,
    asOfMs: closeMs,
    source: `yahoo-asof:${interval}`,
  };
  return {
    ok: true,
    quote,
    meta: {
      hasBook: false,
      ageSecs: ageSecs(asOfMs, closeMs),
      // Same rule as the live FX path: a reference rate is tradeable for a major, indicative otherwise.
      indicativeOnly: kind === "fx" && !isLiquidFxPair(symbol),
      barSpanSecs: span / 1000,
      note:
        `historical ${interval} bar from Yahoo: close of the bar ${new Date(bar.tMs).toISOString()}–${new Date(closeMs).toISOString()}, ` +
        `the last one completed before ${new Date(asOfMs).toISOString()}. Not a live book — depth and spread unknown; ` +
        `the price is ${interval} granular, not stale.`,
    },
  };
}

/** The tape row is usable if it is a quote from at or before the moment and not older than a closure. */
function usableTapeRow(row: TapeQuoteLike | null, asOfMs: number): TapeQuoteLike | null {
  if (!row) return null;
  const captured = Date.parse(row.captured_at);
  if (Number.isFinite(captured) && captured > asOfMs) return null;
  if (row.asOfMs > asOfMs) return null;
  if (asOfMs - row.asOfMs > MAX_CLOSURE_MS) return null;
  return row;
}

/**
 * The last bar completed at or before asOfMs within the closure bound, trying
 * `first` and then each coarser interval. Fetch failures count as no bars.
 */
async function lastCompletedBar(
  chartSymbol: string,
  asOfMs: number,
  first: AsOfInterval,
  bars: typeof yahooBars,
): Promise<{ bar: Bar; interval: AsOfInterval } | null> {
  for (const interval of LADDER.slice(LADDER.indexOf(first))) {
    const span = SPAN_MS[interval];
    let got: Bar[];
    try {
      got = await bars(chartSymbol, { interval, startMs: asOfMs - LOOKBACK_MS[interval], endMs: asOfMs });
    } catch {
      got = [];
    }
    let best: Bar | null = null;
    for (const b of got) {
      if (b.tMs + span > asOfMs) continue; // still forming at the moment: its close is the future
      if (asOfMs - b.tMs > MAX_CLOSURE_MS + span) continue; // older than any closure a live venue has
      if (!best || b.tMs > best.tMs) best = b;
    }
    if (best) return { bar: best, interval };
  }
  return null;
}

/**
 * Resolve as of a moment in the past. Order: (1) the tape, when its quote is
 * at least as fresh as a bar at this age could be; (2) the last completed
 * Yahoo bar completed at or before asOfMs — price = close, asOfMs = the bar's CLOSE,
 * source "yahoo-asof:<interval>", no bid/ask; if the tape had an older row
 * and the bar is later, the bar wins, else the tape row; (3) Unresolved. Never
 * a live quote. meta.ageSecs is measured against asOfMs, not now.
 */
export async function resolveAsOf(
  symbol: string,
  kind: InstrumentKind | "auto",
  asOfMs: number,
  deps: AsOfDeps = {},
): Promise<Resolution> {
  const sym = canonical(symbol);
  const k: InstrumentKind = kind !== "auto" ? kind : inferKind(sym);
  const nowMs = deps.nowMs ?? Date.now();
  const iso = new Date(asOfMs).toISOString();
  if (!Number.isFinite(asOfMs)) return { ok: false, reason: `${sym}: as-of moment is not a time` };
  if (asOfMs > nowMs) return { ok: false, reason: `${sym}: as-of moment ${iso} is in the future` };

  let row: TapeQuoteLike | null = null;
  if (deps.tape) {
    try {
      row = usableTapeRow(await deps.tape(sym, asOfMs), asOfMs);
    } catch {
      row = null; // a tape outage is not a reason to invent a price; fall through to bars
    }
  }
  const first = intervalForAge(nowMs - asOfMs);
  if (row && asOfMs - row.asOfMs <= SPAN_MS[first]) return fromTape(row, asOfMs);

  const chart = yahooChartSymbol(sym, k);
  const found = chart ? await lastCompletedBar(chart, asOfMs, first, deps.bars ?? yahooBars) : null;
  if (found && (!row || found.bar.tMs + SPAN_MS[found.interval] > row.asOfMs)) return fromBar(sym, k, found.bar, found.interval, asOfMs);
  if (row) return fromTape(row, asOfMs);
  return { ok: false, reason: `no historical quote for ${sym} as of ${iso}` };
}

/**
 * Entry/exit scoring as-of. Entry = the as-of quote at the side you would
 * actually trade (score.ts: buys and counterfactual holds at the ask, sells at
 * the bid; a bar has neither, so its close). Exit = resolveAsOf at
 * entryMs + horizonMs, valued at the other side. Null when the horizon has not
 * elapsed yet or either side is unresolvable. Signed so positive = the
 * decision's direction was right; "hold" is scored as if long.
 */
export async function historicalReturn(
  symbol: string,
  kind: InstrumentKind | "auto",
  action: "buy" | "sell" | "hold",
  entryMs: number,
  horizonMs: number,
  deps: AsOfDeps = {},
): Promise<{ entry: number; exit: number; ret: number; entrySource: string; exitSource: string } | null> {
  const nowMs = deps.nowMs ?? Date.now();
  const exitMs = entryMs + horizonMs;
  if (exitMs > nowMs) return null; // no exit price exists yet
  const entryRes = await resolveAsOf(symbol, kind, entryMs, deps);
  if (!entryRes.ok) return null;
  const exitRes = await resolveAsOf(symbol, kind, exitMs, deps);
  if (!exitRes.ok) return null;
  const entry = entryPrice(entryRes.quote, action);
  const exit = exitPrice(exitRes.quote, action);
  if (!(entry > 0) || !(exit > 0)) return null;
  return {
    entry,
    exit,
    ret: signedReturn(action, entry, exit),
    entrySource: entryRes.quote.source,
    exitSource: exitRes.quote.source,
  };
}
