// SPDX-License-Identifier: MIT-0
/**
 * Spend and exposure guards (all off by default). Pure, so each rule
 * is unit-tested (test/guards.test.ts); watch.ts and pipeline.ts supply state. All are off unless
 * their config knob is set, so an arm's behaviour changes only when its env says so.
 */

/**
 * Position-alert threshold scaled to the instrument's own volatility: max(base, k × daily σ).
 * A fixed ±5% fired on every quiet day of a nano-cap whose normal day is ±6%. On Oct 1–Nov 5
 * alerts, k = 1.5 would have skipped 66% (v2) and 60% (v3) of alerts, and the
 * sells among the skipped ones were right 14/30 and 17/32 at 7 days — no better than a coin.
 * k ≤ 0 or an unknown σ leaves the base threshold.
 */
export function alertThresholdPct(basePct: number, dailySigmaPct: number | null, k: number): number {
  if (!(k > 0) || dailySigmaPct === null || !(dailySigmaPct > 0)) return basePct;
  return Math.max(basePct, k * dailySigmaPct);
}

/** Daily σ (%) from closes (oldest first): sample stdev of log returns. null with fewer than 10 returns. */
export function dailySigmaPct(closes: number[]): number | null {
  const c = closes.filter((x) => x > 0);
  if (c.length < 11) return null;
  const r: number[] = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * 100;
}

/**
 * Daily review, manage-only (V2_REVIEW_MANAGE_ONLY=1): the review may exit, trim, cover or hold,
 * never open or add. Positions OPENED by daily reviews were the desks' worst group of trades
 * (three election-morning bets among them); the mandate's "deploy from the watchlist"
 * pressure lands hardest there. Returns the refusal reason, or null when the action may proceed.
 */
export function reviewRefusal(trigger: string | undefined, action: "buy" | "sell", heldQty: number): string | null {
  if (trigger !== "daily-review") return null;
  if (action === "buy" && heldQty >= 0) return "review_manage_only: the daily review does not open or add to positions";
  if (action === "sell" && heldQty <= 0) return "review_manage_only: the daily review does not open or add to shorts";
  return null;
}

/** Does this action add exposure (open/add a long, open/add a short)? Exits and covers do not. */
export function addsExposure(action: "buy" | "sell", heldQty: number): boolean {
  return action === "buy" ? heldQty >= 0 : heldQty <= 0;
}

/**
 * New exposure one decision may open, across all its actions (V2_MAX_NEW_EXPOSURE_PCT of equity).
 * Returns how much of `requestedUsd` is allowed given what earlier actions of the same decision
 * already opened; 0 means drop it.
 */
export function exposureAllowance(capPct: number, equityUsd: number, usedUsd: number, requestedUsd: number): number {
  if (!(capPct > 0) || !(equityUsd > 0)) return requestedUsd;
  const room = (capPct / 100) * equityUsd - usedUsd;
  return Math.max(0, Math.min(requestedUsd, room));
}
