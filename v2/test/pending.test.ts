// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  isExpired,
  PARKABLE_REASONS,
  RETRY_WHILE_REDUCING,
  MIN_SLICE_USD,
  isReduction,
  positionAfterFill,
  sliceDue,
  remainderAfter,
  type PendingOrder,
} from "../src/pending.js";
import { config } from "../src/config.js";
import { fillPrice } from "../src/exec.js";

const order: PendingOrder = {
  symbol: "USO",
  kind: "equity",
  side: "buy",
  notional_usd: 5000,
  limit_price: 132,
  confidence: 0.6,
  news_id: "n1",
  created_at: "2026-08-31T04:34:00Z",
  expires_at: "2026-09-01T04:34:00Z",
  parked_reason: "dropped_stale_quote",
  rationale: "hormuz",
};

describe("pending orders", () => {
  it("expires exactly at expires_at", () => {
    expect(isExpired(order, Date.parse("2026-09-01T04:33:59Z"))).toBe(false);
    expect(isExpired(order, Date.parse("2026-09-01T04:34:00Z"))).toBe(true);
  });
  it("only stale-quote and limit misses are parkable", () => {
    expect(PARKABLE_REASONS.has("dropped_stale_quote")).toBe(true);
    expect(PARKABLE_REASONS.has("limit_not_met")).toBe(true);
    expect(PARKABLE_REASONS.has("insufficient_cash")).toBe(false);
    expect(PARKABLE_REASONS.has("no_position")).toBe(false);
    expect(PARKABLE_REASONS.has("unresolvable")).toBe(false);
  });
});

describe("limit price semantics (via fillPrice + exec check contract)", () => {
  it("buy fills only at/below the limit; sell at/above", () => {
    // fillPrice itself has no limit knowledge — exec compares afterwards.
    const q = { symbol: "X", kind: "equity" as const, price: 130, asOfMs: Date.now(), source: "t" };
    const buy = fillPrice(q, "buy")!.fillPrice; // 130 * 1.0002
    expect(buy).toBeGreaterThan(130);
    expect(buy <= 132).toBe(true); // would fill under order.limit_price
    expect(buy <= 129).toBe(false); // would park under a tighter limit
  });
});

// ---------------------------------------------------------------------------
// Working exits: the remainder of a liquidity-capped REDUCTION stays parked and
// is sliced again later, instead of being dropped (2026-09-08: $7,107 of exits
// filled $43 and the rest vanished).
// ---------------------------------------------------------------------------

describe("working exits (liquidity-capped remainders)", () => {
  const exit: PendingOrder = {
    ...order,
    symbol: "tx:YES",
    kind: "prediction",
    side: "sell",
    notional_usd: 5215,
    limit_price: 0.12,
    parked_reason: "liquidity_capped",
  };
  const now = Date.parse("2026-09-08T13:21:46Z");
  const sliceMs = config.pendingSliceMinutes * 60_000;

  it("a reduction is a sell against a long or a buy against a short", () => {
    expect(isReduction("sell", 37175)).toBe(true);
    expect(isReduction("sell", 0)).toBe(false);
    expect(isReduction("sell", -10)).toBe(false);
    expect(isReduction("buy", -10)).toBe(true);
    expect(isReduction("buy", 10)).toBe(false);
    expect(positionAfterFill(37175, "sell", 80)).toBe(37095);
    expect(positionAfterFill(-2149.58100152, "buy", 149.58100152)).toBe(-2000);
  });

  it("keeps the remainder working, reduce-only and paced, with the original expiry", () => {
    const rest = remainderAfter(exit, 11.2, 37095, now)!;
    expect(rest).not.toBeNull();
    expect(rest.notional_usd).toBeCloseTo(5203.8);
    expect(rest.filled_usd).toBeCloseTo(11.2);
    expect(rest.requested_usd).toBe(5215);
    expect(rest.reduce_only).toBe(true);
    expect(rest.parked_reason).toBe("liquidity_capped");
    expect(rest.expires_at).toBe(exit.expires_at);
    expect(rest.limit_price).toBe(0.12);
    expect(rest.not_before).toBe(new Date(now + sliceMs).toISOString());
    // Second slice: totals accumulate, the asked-for size is remembered.
    const rest2 = remainderAfter(rest, 10.5, 37020, now + sliceMs)!;
    expect(rest2.notional_usd).toBeCloseTo(5193.3);
    expect(rest2.filled_usd).toBeCloseTo(21.7);
    expect(rest2.requested_usd).toBe(5215);
  });

  it("pacing: a slice is due only after not_before; a plain parked order is always due", () => {
    const rest = remainderAfter(exit, 11.2, 37095, now)!;
    expect(sliceDue(rest, now)).toBe(false);
    expect(sliceDue(rest, now + sliceMs - 1)).toBe(false);
    expect(sliceDue(rest, now + sliceMs)).toBe(true);
    expect(sliceDue(exit, now)).toBe(true);
  });

  it("stops at dust, and when the position it was reducing is gone or flipped", () => {
    expect(remainderAfter({ ...exit, notional_usd: 12 }, 11.2, 100, now)).toBeNull(); // $0.80 < MIN_SLICE_USD
    expect(MIN_SLICE_USD).toBe(1);
    expect(remainderAfter(exit, 11.2, 0, now)).toBeNull();
    expect(remainderAfter(exit, 11.2, -5, now)).toBeNull();
    // Covering a short: remainder lives while the short remains.
    const cover: PendingOrder = { ...exit, symbol: "RKDA", kind: "equity", side: "buy", notional_usd: 1000 };
    expect(remainderAfter(cover, 250, -1500, now)).toMatchObject({ notional_usd: 750, reduce_only: true });
    expect(remainderAfter(cover, 250, 0, now)).toBeNull();
  });

  it("a working exit waits through an empty or sub-$1 book; a plain parked order does not", () => {
    expect(RETRY_WHILE_REDUCING.has("dropped_illiquid")).toBe(true);
    expect(RETRY_WHILE_REDUCING.has("dropped_empty_book")).toBe(true);
    expect(RETRY_WHILE_REDUCING.has("dropped_stale_quote")).toBe(true);
    expect(RETRY_WHILE_REDUCING.has("limit_not_met")).toBe(true);
    expect(RETRY_WHILE_REDUCING.has("position_closed")).toBe(false);
    expect(RETRY_WHILE_REDUCING.has("insufficient_cash")).toBe(false);
    expect(PARKABLE_REASONS.has("dropped_illiquid")).toBe(false);
  });
});
