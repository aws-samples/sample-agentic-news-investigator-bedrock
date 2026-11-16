// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { isDust, positionValueUsd, snapExitQty, splitDust } from "../src/dust.js";

const pos = (symbol: string, qty: number, px: number) => ({ symbol, qty, avg_cost: px, last_watch_price: px });

describe("dust", () => {
  it("values a line at the watcher's last price, else cost, either side", () => {
    expect(positionValueUsd(pos("A", -10, 2))).toBe(20);
    expect(positionValueUsd({ symbol: "B", qty: 2, avg_cost: 5 })).toBe(10);
  });

  it("splits real positions from rounding remainders", () => {
    const { real, dust, dustValueUsd } = splitDust([pos("BBNX", 0.0087, 20.05), pos("XOM", 10, 110), pos("FLNA", -12.71, 0.935)], 25);
    expect(real.map((p) => p.symbol)).toEqual(["XOM"]);
    expect(dust.map((p) => p.symbol)).toEqual(["BBNX", "FLNA"]);
    expect(dustValueUsd).toBeCloseTo(0.0087 * 20.05 + 12.71 * 0.935, 6);
    expect(isDust(pos("X", 1, 24.99), 25)).toBe(true);
    expect(isDust(pos("X", 1, 25), 25)).toBe(false);
  });
});

describe("snapExitQty", () => {
  const base = { fillPrice: 20, dustUsd: 25 };
  it("closes exactly when a sell would leave a sliver long", () => {
    expect(snapExitQty({ ...base, action: "sell", oldQty: 100, qty: 99.2 })).toBe(100);
  });
  it("closes exactly when a sell would tip into a sliver short", () => {
    expect(snapExitQty({ ...base, action: "sell", oldQty: 100, qty: 100.9 })).toBe(100);
  });
  it("covers a short exactly", () => {
    expect(snapExitQty({ ...base, action: "buy", oldQty: -50, qty: 49.5 })).toBe(50);
  });
  it("leaves a genuine partial exit alone", () => {
    expect(snapExitQty({ ...base, action: "sell", oldQty: 100, qty: 40 })).toBe(40);
  });
  it("leaves a real flip into an opposite position alone", () => {
    expect(snapExitQty({ ...base, action: "sell", oldQty: 10, qty: 60 })).toBe(60);
  });
  it("never touches an order that adds to or opens a position", () => {
    expect(snapExitQty({ ...base, action: "buy", oldQty: 100, qty: 0.5 })).toBe(0.5);
    expect(snapExitQty({ ...base, action: "sell", oldQty: 0, qty: 0.5 })).toBe(0.5);
    expect(snapExitQty({ ...base, action: "sell", oldQty: -5, qty: 0.5 })).toBe(0.5);
  });
});
