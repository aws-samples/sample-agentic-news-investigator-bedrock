// SPDX-License-Identifier: MIT-0
/**
 * As-of prediction-contract quotes for the bench from the venues' own history, for contracts
 * the quote tape never saw (the tape only holds what an arm happened to observe, since 2026-09-04):
 *   Kalshi: 1-minute candlesticks — real yes bid/ask; a candle is emitted only when the book
 *     changes, so the last one within the hour stands.
 *   Polymarket: prices-history at fidelity=1 (one-minute points), at most 5 min old; no book, so
 *     bid/ask are taken 1c either side. NEVER the hourly series: its points sit 50-59 min before an
 *     on-the-hour snapshot, and in the v4 studies that staleness manufactured every "edge".
 * Gated by V2_BENCH_PREDICTION_HISTORY=1 so earlier benches stay comparable. No depth is known.
 * A market is never priced at or after it closed or resolved (Polymarket closedTime / umaEndDate,
 * Kalshi close_time / settlement_ts): its history keeps printing afterwards, and bench-v5-sep28-oct08
 * "bought" fed-rate-hike-by-september YES at 0.86 on Sep 28, twelve days after it resolved YES.
 */
import { splitSide } from "./prediction.js";
import type { Quote, Resolution } from "../types.js";
import { sourceEnabled } from "../sources.js";

const UA = { "user-agent": "fin-bench/0.1" };
const KB = "https://api.elections.kalshi.com/trade-api/v2";
const memo = new Map<string, Promise<any>>();
const getJson = (url: string): Promise<any> => {
  if (!memo.has(url))
    memo.set(
      url,
      fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  return memo.get(url)!;
};

export const predictionHistoryEnabled = (): boolean => (process.env.V2_BENCH_PREDICTION_HISTORY ?? "") === "1";

/** Pure: true when asOfMs is at or after the earliest valid close/resolution timestamp given. */
export function closedBy(asOfMs: number, ...stamps: (string | null | undefined)[]): boolean {
  const ms = stamps
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .map((x) => Date.parse(x.replace(" ", "T").replace(/\+00$/, "Z")))
    .filter((x) => Number.isFinite(x));
  return ms.length > 0 && asOfMs >= Math.min(...ms);
}

function resolution(symbol: string, price: number, bid: number, ask: number, pointMs: number, asOfMs: number, source: string, note: string): Resolution {
  const quote: Quote = { symbol, kind: "prediction", price, bid, ask, asOfMs: pointMs, source };
  return { ok: true, quote, meta: { hasBook: true, ageSecs: Math.max(0, Math.round((asOfMs - pointMs) / 1000)), indicativeOnly: false, note } } as Resolution;
}

async function kalshiAsOf(symbol: string, ticker: string, yes: boolean, asOfMs: number): Promise<Resolution | null> {
  const m = (await getJson(`${KB}/markets/${ticker}`))?.market ?? (await getJson(`${KB}/historical/markets/${ticker}`))?.market;
  if (!m) return null;
  if (closedBy(asOfMs, m.close_time, m.settlement_ts)) return null;
  const series = String(m.event_ticker ?? "").split("-")[0];
  const end = Math.floor(asOfMs / 1000);
  const start = end - 3600;
  const live = await getJson(`${KB}/series/${series}/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`);
  const cs: any[] = live?.candlesticks?.length ? live.candlesticks : ((await getJson(`${KB}/historical/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=1`))?.candlesticks ?? []);
  const c = cs.filter((x) => x.end_period_ts <= end).at(-1);
  if (!c) return null;
  const yb = Number(c.yes_bid?.close_dollars ?? c.yes_bid?.close);
  const ya = Number(c.yes_ask?.close_dollars ?? c.yes_ask?.close);
  if (!(ya > 0) || !(yb >= 0)) return null;
  const [bid, ask] = yes ? [yb, ya] : [1 - ya, 1 - yb];
  return resolution(symbol, (bid + ask) / 2, bid, ask, c.end_period_ts * 1000, asOfMs, "kalshi-history", "Kalshi 1-minute candle (yes bid/ask)");
}

async function polymarketAsOf(symbol: string, slug: string, yes: boolean, asOfMs: number): Promise<Resolution | null> {
  const ms: any[] = (await getJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`)) ?? [];
  const closed: any[] = ms.length ? [] : ((await getJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&closed=true`)) ?? []);
  const m = ms[0] ?? closed[0];
  if (!m) return null;
  if (closedBy(asOfMs, m.closed ? m.closedTime : null, m.closed ? m.umaEndDate : null)) return null;
  let tokens: string[] = [];
  try {
    tokens = JSON.parse(m.clobTokenIds ?? "[]");
  } catch {
    return null;
  }
  const token = tokens[yes ? 0 : 1];
  if (!token) return null;
  const end = Math.floor(asOfMs / 1000);
  const h = (await getJson(`https://clob.polymarket.com/prices-history?market=${token}&startTs=${end - 1800}&endTs=${end}&fidelity=1`))?.history ?? [];
  const p = (h as any[]).filter((x) => x.t <= end).at(-1);
  if (!p || end - p.t > 300) return null;
  const px = Number(p.p);
  return resolution(symbol, px, Math.max(0.001, px - 0.01), Math.min(0.999, px + 0.01), p.t * 1000, asOfMs, "polymarket-history", "Polymarket 1-minute price history (no book: 1c assumed either side)");
}

/** As-of quote for a prediction symbol (<slug>:YES / <TICKER>:NO) from venue history, or null. */
export async function predictionAsOf(symbol: string, asOfMs: number): Promise<Resolution | null> {
  const s = splitSide(symbol);
  if (!s) return null;
  const kalshiFirst = s.id === s.id.toUpperCase();
  // Opt-in sources (sources.ts): a disabled venue makes no network call.
  const kalshi = () => (sourceEnabled("kalshi") ? kalshiAsOf(symbol, s.id, s.yes, asOfMs) : Promise.resolve(null));
  const polymarket = () => (sourceEnabled("polymarket") ? polymarketAsOf(symbol, s.id, s.yes, asOfMs) : Promise.resolve(null));
  return kalshiFirst ? (await kalshi()) ?? (await polymarket()) : (await polymarket()) ?? (await kalshi());
}
