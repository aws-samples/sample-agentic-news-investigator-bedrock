// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { exitQtyForUnshortable, fillPrice, round8, withKalshiFee } from "../src/exec.js";
import type { Quote } from "../src/types.js";

const base: Quote = {
  symbol: "X",
  kind: "fx",
  price: 100,
  asOfMs: Date.now(),
  source: "test",
};

describe("fillPrice", () => {
  it("crosses the full spread when a book exists", () => {
    const q = { ...base, bid: 99, ask: 101 };
    expect(fillPrice(q, "buy")!.fillPrice).toBe(101);
    expect(fillPrice(q, "sell")!.fillPrice).toBe(99);
    expect(fillPrice(q, "buy")!.slippageBps).toBeCloseTo(100);
    expect(fillPrice(q, "sell")!.slippageBps).toBeCloseTo(100);
  });

  it("applies 2 bps adverse without a book", () => {
    expect(fillPrice(base, "buy")!.fillPrice).toBeCloseTo(100.02);
    expect(fillPrice(base, "sell")!.fillPrice).toBeCloseTo(99.98);
  });

  it("refuses one-sided books on the missing side", () => {
    const onlyBid = { ...base, bid: 99 };
    expect(fillPrice(onlyBid, "buy")).toBeNull();
    expect(fillPrice(onlyBid, "sell")!.fillPrice).toBe(99);
    const onlyAsk = { ...base, ask: 101 };
    expect(fillPrice(onlyAsk, "sell")).toBeNull();
    expect(fillPrice(onlyAsk, "buy")!.fillPrice).toBe(101);
  });
});

describe("round8", () => {
  it("rounds to 8 decimal places", () => {
    expect(round8(1 / 3)).toBe(0.33333333);
    expect(round8(5000 / 161.912)).toBe(30.88097238);
  });
});

describe("withKalshiFee (V2_KALSHI_FEES=1)", () => {
  const kalshi: Quote = { ...base, symbol: "KXFEDDECISION-26DEC-H0:NO", kind: "prediction", price: 0.705, bid: 0.7, ask: 0.71, source: "kalshi" };
  it("folds the per-order fee into a Kalshi buy and sell", () => {
    const buy = withKalshiFee(fillPrice(kalshi, "buy")!, kalshi, 100, "buy");
    expect(buy.fillPrice).toBeCloseTo(0.71 + 1.45 / 100, 8); // 0.07 × 100 × 0.71 × 0.29 = 1.4413 → $1.45
    const sell = withKalshiFee(fillPrice(kalshi, "sell")!, kalshi, 100, "sell");
    expect(sell.fillPrice).toBeCloseTo(0.7 - 1.47 / 100, 8); // 1.47 → $1.47
  });
  it("leaves Polymarket and other venues untouched", () => {
    const poly: Quote = { ...kalshi, symbol: "some-slug:YES", source: "polymarket" };
    expect(withKalshiFee(fillPrice(poly, "buy")!, poly, 100, "buy").fillPrice).toBe(0.71);
    expect(withKalshiFee(fillPrice(base, "buy")!, base, 1, "buy").fillPrice).toBeCloseTo(100.02);
  });
});

describe("exitQtyForUnshortable", () => {
  it("turns an oversized contract sell into a full exit (v6 Maine, 2026-11-04)", () => {
    // 7,142 held; "$2,000" at 0.095 is 21,052 contracts.
    expect(exitQtyForUnshortable("prediction", "sell", 7142, 21052)).toBe(7142);
    expect(exitQtyForUnshortable("prediction", "sell", 7142, 3000)).toBe(3000);
  });
  it("leaves shortable kinds, buys and unheld symbols to the normal rules", () => {
    expect(exitQtyForUnshortable("equity", "sell", 100, 250)).toBe(250);
    expect(exitQtyForUnshortable("prediction", "buy", 100, 250)).toBe(250);
    expect(exitQtyForUnshortable("prediction", "sell", 0, 250)).toBe(250);
  });
});
