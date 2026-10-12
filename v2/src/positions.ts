// SPDX-License-Identifier: MIT-0
/**
 * Signed-position arithmetic. qty > 0 is long, qty < 0 is short; avg_cost is the
 * average entry price on either side. Pure, so the ledger math is tested.
 *
 * A short is marked at the ask (what covering costs), a long at the bid (what
 * liquidating fetches). Unrealized = (mark - avg_cost) * qty on both sides.
 */

export interface PositionState {
  qty: number;
  avg_cost: number;
}

export interface FillEffect {
  newQty: number;
  newAvgCost: number;
  realizedPnl: number;
  /** How much of the fill closed existing exposure (the rest opened new). */
  closedQty: number;
}

export function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

export function applyFill(
  existing: PositionState | null,
  side: "buy" | "sell",
  qty: number,
  price: number,
): FillEffect {
  const oldQty = existing?.qty ?? 0;
  const oldAvg = existing?.avg_cost ?? 0;
  const delta = side === "buy" ? qty : -qty;
  const newQty = round8(oldQty + delta);
  if (oldQty === 0 || Math.sign(oldQty) === Math.sign(delta)) {
    // Opening or adding on the same side: average in.
    const newAvg = (Math.abs(oldQty) * oldAvg + qty * price) / Math.abs(newQty);
    return { newQty, newAvgCost: newAvg, realizedPnl: 0, closedQty: 0 };
  }
  // Reducing, closing, or flipping through zero.
  const closedQty = Math.min(qty, Math.abs(oldQty));
  const realizedPnl = (price - oldAvg) * closedQty * Math.sign(oldQty);
  if (qty > Math.abs(oldQty)) {
    // Flip: the remainder opens a fresh position on the other side at this price.
    return { newQty, newAvgCost: price, realizedPnl, closedQty };
  }
  return { newQty, newAvgCost: oldAvg, realizedPnl, closedQty };
}

/**
 * Collateral, not judgment: a paper broker lends nothing. Total short exposure
 * (at entry prices) may not exceed the account's book equity (cash plus signed
 * cost of open positions, i.e. seed plus realized P&L).
 */
export function shortCollateralOk(shortExposureAfter: number, bookEquity: number): boolean {
  return shortExposureAfter <= Math.max(0, bookEquity) + 1e-6;
}

export function bookEquity(cash: number, positions: PositionState[]): number {
  return cash + positions.reduce((s, p) => s + p.qty * p.avg_cost, 0);
}

export function shortExposure(positions: PositionState[]): number {
  return positions.filter((p) => p.qty < 0).reduce((s, p) => s + Math.abs(p.qty) * p.avg_cost, 0);
}

export type ReduceOnlyResult =
  | { ok: true; qty: number }
  | { ok: false; reason: "position_closed"; detail: string };

/**
 * Reduce-only: the order may only shrink the position it was placed against —
 * a sell caps at the long held, a buy at the short outstanding — and is refused
 * once that position is gone. Set on the working remainder of a liquidity-capped
 * exit (never by the agent), so a sliced exit can never flip a long into a short
 * after a later decision closed part of it first.
 */
export function clampReduceOnly(
  side: "buy" | "sell",
  oldQty: number,
  qty: number,
  symbol = "",
): ReduceOnlyResult {
  const room = side === "sell" ? Math.max(0, oldQty) : Math.max(0, -oldQty);
  if (room <= 0) {
    return {
      ok: false,
      reason: "position_closed",
      detail: `${symbol}: reduce-only ${side} but no ${side === "sell" ? "long" : "short"} position remains (qty ${oldQty})`,
    };
  }
  return { ok: true, qty: Math.min(qty, room) };
}
