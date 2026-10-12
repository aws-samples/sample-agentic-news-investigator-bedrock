// SPDX-License-Identifier: MIT-0
import type { Quote, InstrumentKind } from "../types.js";

/**
 * Kraken public Ticker. Accepts plain 6-letter fiat pairs verbatim
 * (EURUSD -> internal key ZEURZUSD, USDJPY -> ZUSDZJPY; verified 2026-08-30).
 * NEVER batch pairs: one unknown pair fails the whole request.
 */
export function parseKrakenTicker(
  body: unknown,
  symbol: string,
  kind: InstrumentKind,
): Quote | null {
  const b = body as any;
  if (Array.isArray(b?.error) && b.error.length > 0) return null;
  const result = b?.result;
  if (!result || typeof result !== "object") return null;
  const entry: any = Object.values(result)[0];
  const ask = Number(entry?.a?.[0]);
  const bid = Number(entry?.b?.[0]);
  const last = Number(entry?.c?.[0]);
  if (!Number.isFinite(last) && !(Number.isFinite(bid) && Number.isFinite(ask))) {
    return null;
  }
  const price =
    Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0
      ? (bid + ask) / 2
      : last;
  return {
    symbol,
    kind,
    price,
    bid: Number.isFinite(bid) && bid > 0 ? bid : undefined,
    ask: Number.isFinite(ask) && ask > 0 ? ask : undefined,
    // Kraken doesn't timestamp the ticker; it's a live top-of-book snapshot.
    asOfMs: Date.now(),
    source: "kraken",
  };
}

async function fetchTicker(pair: string): Promise<unknown | null> {
  try {
    const resp = await fetch(
      `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** FX majors: pass the 6-letter pair verbatim (do NOT append USD). */
export async function krakenFxQuote(pair: string): Promise<Quote | null> {
  const body = await fetchTicker(pair);
  return body ? parseKrakenTicker(body, pair, "fx") : null;
}

/** Crypto: "BTC" -> pair "BTCUSD". */
export async function krakenCryptoQuote(symbol: string): Promise<Quote | null> {
  const pair = symbol.endsWith("USD") ? symbol : `${symbol}USD`;
  const body = await fetchTicker(pair);
  return body ? parseKrakenTicker(body, symbol, "crypto") : null;
}
