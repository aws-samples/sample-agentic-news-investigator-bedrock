// SPDX-License-Identifier: MIT-0
import type { Quote } from "../types.js";

/**
 * CriptoYa aggregates USDT top-of-book per exchange in LatAm fiats — the
 * parallel ("blue") exchange rate where capital controls make the official
 * rate fictional. GET https://criptoya.com/api/usdt/{fiat}/1 returns a flat
 * object keyed by exchange: {ask, totalAsk, bid, totalBid, time} (verified
 * 2026-08-30: 36 venues for ARS, 7 for BOB).
 *
 * Venue data is noisy: sides can be 0 (huobip2p had no ask) and entries can
 * be hours stale at prices ~30% off market. So: drop zero sides, drop entries
 * older than FRESHNESS_SECS, and take the MEDIAN of the survivors — CriptoYa
 * exposes no volumes, and a median is the robust unweighted estimator
 * (bolivianblue.net does outlier-removal + volume-weighted average over the
 * same underlying venues). Require >= 2 survivors per side so a single stale
 * P2P venue can never set the rate.
 */
export const FRESHNESS_SECS = 15 * 60;
const MIN_VENUES = 2;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function parseCriptoya(
  body: unknown,
  symbol: string,
  nowMs: number,
): Quote | null {
  if (!body || typeof body !== "object") return null;
  const asks: number[] = [];
  const bids: number[] = [];
  let newestMs = 0;
  for (const entry of Object.values(body as Record<string, any>)) {
    const time = Number(entry?.time);
    if (!Number.isFinite(time)) continue;
    const ageMs = nowMs - time * 1000;
    if (ageMs > FRESHNESS_SECS * 1000) continue;
    const ask = Number(entry?.ask);
    const bid = Number(entry?.bid);
    let counted = false;
    if (Number.isFinite(ask) && ask > 0) {
      asks.push(ask);
      counted = true;
    }
    if (Number.isFinite(bid) && bid > 0) {
      bids.push(bid);
      counted = true;
    }
    if (counted) newestMs = Math.max(newestMs, time * 1000);
  }
  if (asks.length < MIN_VENUES || bids.length < MIN_VENUES) return null;
  const ask = median(asks);
  const bid = median(bids);
  return {
    symbol,
    kind: "parallel_fx",
    price: (bid + ask) / 2,
    bid,
    ask,
    asOfMs: newestMs,
    source: "criptoya",
  };
}

/** "USDTARS" -> fiat "ars". Any fiat CriptoYa serves works. */
export function criptoyaFiat(symbol: string): string | null {
  const m = /^USDT([A-Z]{3})$/.exec(symbol);
  return m ? m[1].toLowerCase() : null;
}

export async function criptoyaQuote(symbol: string): Promise<Quote | null> {
  const fiat = criptoyaFiat(symbol);
  if (!fiat) return null;
  try {
    const resp = await fetch(`https://criptoya.com/api/usdt/${fiat}/1`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return parseCriptoya(await resp.json(), symbol, Date.now());
  } catch {
    return null;
  }
}
