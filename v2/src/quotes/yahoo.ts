// SPDX-License-Identifier: MIT-0
import type { Quote, InstrumentKind } from "../types.js";
import { sourceEnabled } from "../sources.js";

const HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
// Yahoo rejects default fetch UAs.
const UA = "Mozilla/5.0 fin-paper-trader/0.2";

export interface ChartMeta {
  price: number;
  asOfMs: number;
  instrumentType?: string;
}

/** Parse the chart-API meta block. Shape verified live 2026-08-30 (NZDUSD=X). */
export function parseChartMeta(body: unknown): ChartMeta | null {
  const meta = (body as any)?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const time = meta?.regularMarketTime;
  if (typeof price !== "number" || typeof time !== "number") return null;
  return {
    price,
    asOfMs: time * 1000,
    instrumentType: meta?.instrumentType,
  };
}

// Every fetch below is gated: Yahoo is an opt-in source (sources.ts).
async function fetchChart(yahooSymbol: string): Promise<ChartMeta | null> {
  if (!sourceEnabled("yahoo")) return null;
  for (const host of HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
        yahooSymbol,
      )}?interval=1m&range=1d`;
      const resp = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const meta = parseChartMeta(await resp.json());
      if (meta) return meta;
    } catch {
      // try next host
    }
  }
  return null;
}

/** Any FX pair Yahoo quotes, e.g. "EURUSD" -> chart symbol "EURUSD=X". No bid/ask. */
export async function yahooFxQuote(pair: string): Promise<Quote | null> {
  const meta = await fetchChart(`${pair}=X`);
  if (!meta) return null;
  return {
    symbol: pair,
    kind: "fx",
    price: meta.price,
    asOfMs: meta.asOfMs,
    source: "yahoo",
  };
}

/** Any coin Yahoo quotes, e.g. "OM" -> "OM-USD". No bid/ask: the 2 bps adverse fill applies. */
export async function yahooCryptoQuote(symbol: string): Promise<Quote | null> {
  const meta = await fetchChart(`${symbol}-USD`);
  if (!meta) return null;
  return { symbol, kind: "crypto", price: meta.price, asOfMs: meta.asOfMs, source: "yahoo" };
}

export interface DailyClose {
  tMs: number;
  close: number;
}

/** Daily closes for historical (replay) scoring. Works for FX (=X), equities, crypto (-USD). */
export async function yahooDailyCloses(
  yahooSymbol: string,
  range = "6mo",
): Promise<DailyClose[]> {
  if (!sourceEnabled("yahoo")) return [];
  for (const host of HOSTS) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(
        yahooSymbol,
      )}?interval=1d&range=${range}`;
      const resp = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const body: any = await resp.json();
      const r = body?.chart?.result?.[0];
      const ts: number[] = r?.timestamp ?? [];
      const closes: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
      const out = ts
        .map((t, i) => ({ tMs: t * 1000, close: closes[i] as number }))
        .filter((d) => typeof d.close === "number" && d.close > 0);
      if (out.length > 0) return out;
    } catch {
      // try next host
    }
  }
  return [];
}

/** Equities/ETFs/ADRs, symbol verbatim. No bid/ask. */
export async function yahooEquityQuote(symbol: string): Promise<Quote | null> {
  const meta = await fetchChart(symbol);
  if (!meta) return null;
  const kind: InstrumentKind = "equity";
  return { symbol, kind, price: meta.price, asOfMs: meta.asOfMs, source: "yahoo" };
}

// ---- Historical bars (as-of-event resolution, quotes/asof.ts) ----

/** One chart bar. `tMs` is the bar's OPEN time: the close happened one interval later. */
export interface Bar {
  tMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type BarInterval = "1m" | "5m" | "15m" | "60m" | "1d";

/**
 * Pure: chart-API body -> bars. `timestamp[i]` (epoch seconds) lines up with
 * `indicators.quote[0].{open,high,low,close,volume}[i]`; every field is null
 * for a period with no trade, and those bars are skipped. Open/high/low fall
 * back to the close when only the close is present. Shape verified live
 * 2026-09-04 (AAPL 60m, EURUSD=X 1m, CL=F 1d).
 */
export function parseChartBars(body: unknown): Bar[] {
  const r = (body as any)?.chart?.result?.[0];
  const ts: unknown[] = Array.isArray(r?.timestamp) ? r.timestamp : [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const num = (arr: unknown, i: number): number | undefined => {
    const v = Array.isArray(arr) ? arr[i] : undefined;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const close = num(q.close, i);
    if (typeof t !== "number" || close === undefined || close <= 0) continue;
    const volume = num(q.volume, i);
    out.push({
      tMs: t * 1000,
      open: num(q.open, i) ?? close,
      high: num(q.high, i) ?? close,
      low: num(q.low, i) ?? close,
      close,
      ...(volume !== undefined ? { volume } : {}),
    });
  }
  return out;
}

const DAY_MS = 86_400_000;

/**
 * Pure: the finest interval Yahoo serves for a point `ageMs` in the past.
 * Yahoo keeps 1m bars for ~30 days and serves at most 7 days of them per
 * request; 60m bars go back ~2 years; 1d bars for the life of the listing.
 * The 7-day and 60-day cut-offs are conservative and leave room for the
 * lookback window asof.ts puts in front of the point.
 */
export function intervalForAge(ageMs: number): "1m" | "60m" | "1d" {
  if (ageMs <= 7 * DAY_MS) return "1m";
  if (ageMs <= 60 * DAY_MS) return "60m";
  return "1d";
}

/**
 * Bars in [startMs, endMs] at `interval`, via period1/period2 (epoch seconds),
 * regular session only (Yahoo's default; no pre/post prints). Same query1 ->
 * query2 fallback as the live fetch. Out-of-range requests (1m older than 30
 * days, 60m older than ~730 days) come back as HTTP 422 with an error body
 * and are reported as no bars, like any other failure.
 *
 * Yahoo appends the LATEST regular-session bar to every intraday response no
 * matter how far in the past period2 is (observed 2026-09-04: a 60m window
 * ending eight days earlier carried a final bar stamped at today's close). For
 * an as-of reader that bar is the future, so bars outside the window are
 * dropped here rather than trusted to the caller.
 */
export async function yahooBars(
  chartSymbol: string,
  opts: { interval: BarInterval; startMs: number; endMs: number },
): Promise<Bar[]> {
  if (!sourceEnabled("yahoo")) return [];
  const period1 = Math.floor(opts.startMs / 1000);
  const period2 = Math.ceil(opts.endMs / 1000);
  if (!(period2 > period1)) return [];
  for (const host of HOSTS) {
    try {
      const url =
        `https://${host}/v8/finance/chart/${encodeURIComponent(chartSymbol)}` +
        `?interval=${opts.interval}&period1=${period1}&period2=${period2}`;
      const resp = await fetch(url, {
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const bars = parseChartBars(await resp.json()).filter(
        (b) => b.tMs >= opts.startMs && b.tMs <= opts.endMs,
      );
      if (bars.length > 0) return bars;
    } catch {
      // try next host
    }
  }
  return [];
}
