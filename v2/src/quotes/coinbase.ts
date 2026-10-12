// SPDX-License-Identifier: MIT-0
import type { Quote } from "../types.js";
import { sourceEnabled } from "../sources.js";

/** Coinbase v2 spot price, crypto fallback. No bid/ask. */
export async function coinbaseSpotQuote(symbol: string): Promise<Quote | null> {
  if (!sourceEnabled("coinbase")) return null; // opt-in source (sources.ts)
  try {
    const resp = await fetch(
      `https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return null;
    const body: any = await resp.json();
    const price = Number(body?.data?.amount);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { symbol, kind: "crypto", price, asOfMs: Date.now(), source: "coinbase" };
  } catch {
    return null;
  }
}
