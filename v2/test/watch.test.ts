// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { shouldTrigger, thinBook } from "../src/watch.js";
import {
  parsePolymarketResolution,
  parseKalshiResolution,
} from "../src/quotes/prediction.js";

const NOW = 1_790_000_000_000;
const H = 3_600_000;

describe("shouldTrigger", () => {
  it("fires on a 5% adverse leg (non-prediction)", () => {
    const r = shouldTrigger({ price: 94.9, refPrice: 100, kind: "fx", lastWatchAtMs: null, nowMs: NOW });
    expect(r.trigger).toBe(true);
    expect(r.movePct).toBeCloseTo(-5.1);
  });
  it("fires on favorable legs too (take-profit question)", () => {
    expect(
      shouldTrigger({ price: 106, refPrice: 100, kind: "equity", lastWatchAtMs: null, nowMs: NOW }).trigger,
    ).toBe(true);
  });
  it("does not fire under threshold", () => {
    expect(
      shouldTrigger({ price: 103, refPrice: 100, kind: "equity", lastWatchAtMs: null, nowMs: NOW }).trigger,
    ).toBe(false);
  });
  it("predictions need a bigger move (thin books)", () => {
    expect(
      shouldTrigger({ price: 0.74, refPrice: 0.685, kind: "prediction", lastWatchAtMs: null, nowMs: NOW }).trigger,
    ).toBe(false); // +8% < 10%
    expect(
      shouldTrigger({ price: 0.60, refPrice: 0.685, kind: "prediction", lastWatchAtMs: null, nowMs: NOW }).trigger,
    ).toBe(true); // -12.4%
  });
  it("respects the cooldown", () => {
    expect(
      shouldTrigger({ price: 90, refPrice: 100, kind: "fx", lastWatchAtMs: NOW - 1 * H, nowMs: NOW }).trigger,
    ).toBe(false);
    expect(
      shouldTrigger({ price: 90, refPrice: 100, kind: "fx", lastWatchAtMs: NOW - 5 * H, nowMs: NOW }).trigger,
    ).toBe(true);
  });
});

describe("resolution parsers", () => {
  it("polymarket resolved YES pays the YES holder", () => {
    const body = [{ closed: true, outcomePrices: '["1", "0"]' }];
    expect(parsePolymarketResolution(body, true)).toEqual({ resolved: true, payout: 1 });
    expect(parsePolymarketResolution(body, false)).toEqual({ resolved: true, payout: 0 });
  });
  it("polymarket open market is unresolved", () => {
    expect(parsePolymarketResolution([{ closed: false, outcomePrices: '["0.7","0.3"]' }], true)).toEqual({
      resolved: false,
    });
  });
  it("kalshi settled no pays the NO holder", () => {
    const body = { market: { status: "settled", result: "no" } };
    expect(parseKalshiResolution(body, false)).toEqual({ resolved: true, payout: 1 });
    expect(parseKalshiResolution(body, true)).toEqual({ resolved: true, payout: 0 });
  });
  it("kalshi active market is unresolved", () => {
    expect(parseKalshiResolution({ market: { status: "active" } }, true)).toEqual({ resolved: false });
  });
});

describe("thin-book alerts", () => {
  const NOW = Date.parse("2026-09-03T15:00:00Z");
  it("a qualifying move on a $16 book is reported as thin, not triggered", () => {
    const r = shouldTrigger({ price: 0.1, refPrice: 0.13, kind: "prediction", lastWatchAtMs: null, nowMs: NOW, quote: { price: 0.305, bid: 0.1, ask: 0.51, liquidityUsd: 16.42 } });
    expect(r.trigger).toBe(false);
    expect(r.thin).toMatch(/depth \$16 < \$500/);
    expect(r.movePct).toBeCloseTo(-23.1, 0);
  });
  it("a wide spread alone is enough to call the book thin", () => {
    expect(thinBook({ price: 0.3, bid: 0.1, ask: 0.51, liquidityUsd: 5000 })).toMatch(/spread/);
  });
  it("a deep, tight book still triggers", () => {
    const r = shouldTrigger({ price: 0.36, refPrice: 0.31, kind: "prediction", lastWatchAtMs: null, nowMs: NOW, quote: { price: 0.37, bid: 0.36, ask: 0.38, liquidityUsd: 16230 } });
    expect(r.trigger).toBe(true);
    expect(r.thin).toBeUndefined();
  });
  it("a venue that reports no depth is judged on spread only", () => {
    expect(thinBook({ price: 100, bid: 99.99, ask: 100.01 })).toBeNull();
    expect(thinBook({ price: 100 })).toBeNull();
  });
});
