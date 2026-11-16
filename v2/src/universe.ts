// SPDX-License-Identifier: MIT-0
import { splitSide } from "./quotes/prediction.js";

/**
 * What an arm may trade (pure). "all" is v2/v3: anything with a live quote. "prediction"
 * is v5, the prediction-market desk: Polymarket/Kalshi contracts, and futures only up to a
 * gross cap — as a hedge or the most direct expression of a contract thesis. Reducing a
 * position already held is always allowed, so an exit is never trapped by the rule.
 */
export type Universe = "all" | "prediction";

/** Yahoo futures: continuous (CL=F) or a monthly contract (CLZ26.NYM, ZQV26.CBT). */
export function isFuturesSymbol(symbol: string): boolean {
  return /^[A-Z0-9]{1,6}=F$/i.test(symbol) || /^[A-Z0-9]{1,4}[FGHJKMNQUVXZ]\d{2}\.(NYM|CBT|CME|CMX|NYB)$/i.test(symbol);
}

export interface HeldLine {
  symbol: string;
  qty: number;
  /** Last known price (the watcher's mark, else cost). */
  mark: number;
}

export function universeCheck(a: {
  universe: Universe;
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  held: HeldLine[];
  equityUsd: number | null;
  futuresMaxPct: number;
}): { ok: true } | { ok: false; reason: string } {
  if (a.universe === "all") return { ok: true };
  const line = a.held.find((h) => h.symbol === a.symbol);
  const reduces = line !== undefined && ((line.qty > 0 && a.side === "sell") || (line.qty < 0 && a.side === "buy"));
  if (reduces) return { ok: true };
  if (splitSide(a.symbol)) return { ok: true };
  if (isFuturesSymbol(a.symbol)) {
    if (a.equityUsd === null || !(a.equityUsd > 0)) return { ok: false, reason: "universe: futures need a known equity for the cap" };
    const gross = a.held.filter((h) => isFuturesSymbol(h.symbol)).reduce((s, h) => s + Math.abs(h.qty * h.mark), 0);
    const cap = a.futuresMaxPct * a.equityUsd;
    if (gross + a.notionalUsd > cap + 1e-6) {
      return { ok: false, reason: `universe: futures gross would be $${Math.round(gross + a.notionalUsd)} > cap $${Math.round(cap)} (${Math.round(a.futuresMaxPct * 100)}% of equity)` };
    }
    return { ok: true };
  }
  return { ok: false, reason: `universe: this arm trades prediction contracts (and futures up to ${Math.round(a.futuresMaxPct * 100)}% of equity), not ${a.symbol}` };
}
