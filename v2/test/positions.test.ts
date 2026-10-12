// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { applyFill, bookEquity, shortExposure, shortCollateralOk, clampReduceOnly } from "../src/positions.js";
import { liquidationPrice, SHORTABLE_KINDS } from "../src/exec.js";

describe("applyFill (signed positions)", () => {
  it("opens and averages a long", () => {
    const a = applyFill(null, "buy", 10, 100);
    expect(a).toEqual({ newQty: 10, newAvgCost: 100, realizedPnl: 0, closedQty: 0 });
    const b = applyFill({ qty: 10, avg_cost: 100 }, "buy", 10, 120);
    expect(b.newQty).toBe(20);
    expect(b.newAvgCost).toBe(110);
  });
  it("reduces a long with realized P&L and keeps the average", () => {
    const r = applyFill({ qty: 20, avg_cost: 110 }, "sell", 5, 130);
    expect(r).toEqual({ newQty: 15, newAvgCost: 110, realizedPnl: 100, closedQty: 5 });
  });
  it("opens a short and averages it", () => {
    const a = applyFill(null, "sell", 10, 50);
    expect(a).toEqual({ newQty: -10, newAvgCost: 50, realizedPnl: 0, closedQty: 0 });
    const b = applyFill({ qty: -10, avg_cost: 50 }, "sell", 10, 40);
    expect(b.newQty).toBe(-20);
    expect(b.newAvgCost).toBe(45);
  });
  it("covers a short: profit when the price fell", () => {
    const r = applyFill({ qty: -20, avg_cost: 45 }, "buy", 8, 40);
    expect(r.newQty).toBe(-12);
    expect(r.newAvgCost).toBe(45);
    expect(r.realizedPnl).toBeCloseTo(40, 6); // (45-40)*8
    const loss = applyFill({ qty: -12, avg_cost: 45 }, "buy", 12, 50);
    expect(loss.newQty).toBe(0);
    expect(loss.realizedPnl).toBeCloseTo(-60, 6);
  });
  it("flips through zero: realizes the closed leg and opens the rest at the fill price", () => {
    const r = applyFill({ qty: 10, avg_cost: 100 }, "sell", 15, 90);
    expect(r.newQty).toBe(-5);
    expect(r.newAvgCost).toBe(90);
    expect(r.realizedPnl).toBeCloseTo(-100, 6);
    expect(r.closedQty).toBe(10);
  });
});

describe("collateral and marks", () => {
  it("shorts are marked at the ask, longs at the bid", () => {
    const q = { price: 100, bid: 99, ask: 101 };
    expect(liquidationPrice(q, 5)).toBe(99);
    expect(liquidationPrice(q, -5)).toBe(101);
    expect(liquidationPrice({ price: 1, resolved: true }, -5)).toBe(1);
  });
  it("book equity and short exposure use signed cost", () => {
    const positions = [{ qty: 10, avg_cost: 100 }, { qty: -20, avg_cost: 50 }];
    // cash 100k seed: bought 1000, sold short 1000 -> cash 100000
    expect(bookEquity(100_000, positions)).toBe(100_000);
    expect(shortExposure(positions)).toBe(1000);
    expect(shortCollateralOk(1000, 100_000)).toBe(true);
    expect(shortCollateralOk(100_001, 100_000)).toBe(false);
  });
  it("prediction contracts and parallel rates are not shortable", () => {
    expect(SHORTABLE_KINDS.has("prediction")).toBe(false);
    expect(SHORTABLE_KINDS.has("parallel_fx")).toBe(false);
    expect(SHORTABLE_KINDS.has("equity")).toBe(true);
    expect(SHORTABLE_KINDS.has("fx")).toBe(true);
  });
});

describe("clampReduceOnly (working exits only ever shrink a position)", () => {
  it("caps a sell at the long held and a buy at the short outstanding", () => {
    expect(clampReduceOnly("sell", 100, 250)).toEqual({ ok: true, qty: 100 });
    expect(clampReduceOnly("sell", 100, 40)).toEqual({ ok: true, qty: 40 });
    expect(clampReduceOnly("buy", -30, 50)).toEqual({ ok: true, qty: 30 });
    expect(clampReduceOnly("buy", -30, 10)).toEqual({ ok: true, qty: 10 });
  });
  it("refuses once the position is gone or when the order points the wrong way", () => {
    expect(clampReduceOnly("sell", 0, 10, "X")).toMatchObject({ ok: false, reason: "position_closed" });
    expect(clampReduceOnly("sell", -5, 10)).toMatchObject({ ok: false, reason: "position_closed" });
    expect(clampReduceOnly("buy", 5, 10)).toMatchObject({ ok: false, reason: "position_closed" });
    const r = clampReduceOnly("sell", 0, 10, "TSLA");
    expect(r.ok === false && r.detail).toContain("TSLA");
  });
});
