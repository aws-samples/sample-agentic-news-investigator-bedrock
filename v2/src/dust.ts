// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";

/**
 * Dust: a position line worth less than config.dustUsd (V2_DUST_USD, $25).
 *
 * Exits sized by notional (qty = notional / fill price) almost never land on
 * the exact quantity held, so a "full" exit left a remainder worth cents
 * (0.0087 BBNX = $0.18) or a sliver short. From 2026-09-14 those remainders
 * accumulated to ~130 of the book's ~165 lines, and the watcher investigated
 * each one on every +-5% tick: 45-78% of position alerts and the model spend
 * that goes with them, every one ending "hold, it's dust". The mandate also
 * counted them, telling the agent it held 160 positions against a 4-12 target.
 *
 * Pure: the threshold is an argument with the config default.
 */

export interface PositionLike {
  symbol: string;
  qty: number;
  avg_cost: number;
  last_watch_price?: number | null;
}

/** |qty x price| at the watcher's last price, else cost (the basis the book context already uses). */
export function positionValueUsd(p: PositionLike): number {
  const px = p.last_watch_price ?? p.avg_cost;
  return Math.abs(p.qty * px);
}

export function isDust(p: PositionLike, dustUsd: number = config.dustUsd): boolean {
  return positionValueUsd(p) < dustUsd;
}

export function splitDust<T extends PositionLike>(
  positions: T[],
  dustUsd: number = config.dustUsd,
): { real: T[]; dust: T[]; dustValueUsd: number } {
  const real: T[] = [];
  const dust: T[] = [];
  let dustValueUsd = 0;
  for (const p of positions) {
    if (isDust(p, dustUsd)) {
      dust.push(p);
      dustValueUsd += positionValueUsd(p);
    } else real.push(p);
  }
  return { real, dust, dustValueUsd };
}

/**
 * The quantity a reducing order should fill so it never leaves dust behind.
 * When the order trades against the position and what would remain on either
 * side of zero (a sliver of the old position, or a sliver of a new opposite
 * one) is worth less than dustUsd, close exactly |oldQty| instead. Orders that
 * add to a position, or genuinely flip it into a real opposite position, are
 * returned unchanged.
 */
export function snapExitQty(opts: {
  action: "buy" | "sell";
  oldQty: number;
  qty: number;
  fillPrice: number;
  dustUsd?: number;
}): number {
  const { action, oldQty, qty, fillPrice } = opts;
  const dustUsd = opts.dustUsd ?? config.dustUsd;
  const reduces = (action === "sell" && oldQty > 0) || (action === "buy" && oldQty < 0);
  if (!reduces || !(qty > 0) || !(fillPrice > 0)) return qty;
  const after = action === "sell" ? oldQty - qty : oldQty + qty;
  if (Math.abs(after * fillPrice) < dustUsd) return Math.abs(oldQty);
  return qty;
}
