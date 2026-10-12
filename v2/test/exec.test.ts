// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { fillPrice, round8 } from "../src/exec.js";
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
