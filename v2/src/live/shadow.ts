// SPDX-License-Identifier: MIT-0
import { asksFor, bidsFor, parseKalshiSymbol, parseOrderbook, walkBook, type Book, type Walk } from "./kalshi-core.js";
import { sourceEnabled } from "../sources.js";

/**
 * Shadow mode (V2_SHADOW_KALSHI=1): an OBSERVER of the paper arm, never in its decision or fill
 * path. For every buy/sell on a Kalshi contract, read the real order book at that moment and record
 * what an immediate-or-cancel order would have got: contracts, average price, Kalshi's fee, and
 * the gap to the paper fill. The paper broker fills at the top of book with no fee and a 25%
 * depth cap; this is how far that is from reality, decision by decision, before any money moves.
 * Audited as `v2-shadow` rows next to the decision.
 */

export interface ShadowInput {
  symbol: string;
  action: "buy" | "sell";
  notionalUsd: number;
  limitPrice?: number;
  /** The paper fill, when there was one. */
  paper?: { qty: number; fillPrice: number; notionalUsd: number } | null;
  paperStatus: string;
}

export interface ShadowRecord {
  symbol: string;
  action: "buy" | "sell";
  requested_usd: number;
  limit_price: number | null;
  paper_status: string;
  paper_qty: number | null;
  paper_price: number | null;
  real: Walk & { top: number | null; bookUsd: number };
  /** Real all-in price minus paper price, in cents per contract (positive = reality is worse). */
  gap_cents: number | null;
  /** Share of the requested notional (or paper qty) the real book would have filled. */
  fill_ratio: number;
}

/** Pure: the shadow record for one decision against one book snapshot. */
export function shadowOf(input: ShadowInput, book: Book): ShadowRecord | null {
  const k = parseKalshiSymbol(input.symbol);
  if (!k) return null;
  const levels = input.action === "buy" ? asksFor(book, k.side) : bidsFor(book, k.side);
  // Size it like the paper order did: a buy by dollars, a sell by the contracts paper sold
  // (or by dollars at the top of book when paper sold nothing).
  const real =
    input.action === "buy"
      ? walkBook(levels, { action: "buy", maxUsd: input.notionalUsd, limit: input.limitPrice })
      : walkBook(levels, {
          action: "sell",
          maxCount: input.paper?.qty ?? (levels[0] ? Math.floor(input.notionalUsd / levels[0].price) : 0),
          limit: input.limitPrice,
        });
  const bookUsd = Math.round(levels.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
  const paperPrice = input.paper?.fillPrice ?? null;
  const gap =
    paperPrice !== null && real.count > 0
      ? Math.round((input.action === "buy" ? real.effectivePrice - paperPrice : paperPrice - real.effectivePrice) * 10_000) / 100
      : null;
  const target = input.action === "buy" ? input.notionalUsd : (input.paper?.qty ?? 0) * (levels[0]?.price ?? 0);
  return {
    symbol: input.symbol,
    action: input.action,
    requested_usd: input.notionalUsd,
    limit_price: input.limitPrice ?? null,
    paper_status: input.paperStatus,
    paper_qty: input.paper?.qty ?? null,
    paper_price: paperPrice,
    real: { ...real, top: levels[0]?.price ?? null, bookUsd },
    gap_cents: gap,
    fill_ratio: target > 0 ? Math.min(1, Math.round((real.usd / target) * 1000) / 1000) : 0,
  };
}

/** Reads the public book and returns the record; never throws (an observer must not break the arm). */
export async function shadowKalshi(
  input: ShadowInput,
  orderbook: (ticker: string) => Promise<any>,
): Promise<ShadowRecord | { error: string } | null> {
  const k = parseKalshiSymbol(input.symbol);
  if (!k || !sourceEnabled("kalshi")) return null; // opt-in source (sources.ts)
  try {
    return shadowOf(input, parseOrderbook(await orderbook(k.ticker)));
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}
