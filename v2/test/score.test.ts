// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  signedReturn,
  dueHorizons,
  expiredHorizons,
  isComplete,
  HORIZONS,
  type ScoreItem,
} from "../src/score.js";

const T0 = Date.parse("2026-08-30T12:00:00Z");

function item(overrides: Partial<ScoreItem> = {}): ScoreItem {
  return {
    pk: "SCOREQ",
    sk: `P#2026-08-30T12:00:00Z#news-1`,
    news_id: "news-1",
    symbol: "USDTBOB",
    kind: "parallel_fx",
    action: "buy",
    confidence: 0.6,
    decided_at: "2026-08-30T12:00:00Z",
    dry_run: false,
    degraded: false,
    price0: 12,
    ...overrides,
  };
}

describe("signedReturn", () => {
  it("buy: positive when price rises", () => {
    expect(signedReturn("buy", 100, 105)).toBeCloseTo(0.05);
    expect(signedReturn("buy", 100, 95)).toBeCloseTo(-0.05);
  });
  it("sell: positive when price falls", () => {
    expect(signedReturn("sell", 100, 95)).toBeCloseTo(0.05);
    expect(signedReturn("sell", 100, 105)).toBeCloseTo(-0.05);
  });
  it("hold: counterfactual buy, not sign-flipped", () => {
    expect(signedReturn("hold", 100, 110)).toBeCloseTo(0.1);
  });
});

describe("horizon lifecycle", () => {
  it("nothing due immediately", () => {
    expect(dueHorizons(item(), T0 + 60_000)).toEqual([]);
  });
  it("1h due after an hour; others not", () => {
    expect(dueHorizons(item(), T0 + HORIZONS["1h"] + 1)).toEqual(["1h"]);
  });
  it("all due after 7 days", () => {
    expect(dueHorizons(item(), T0 + HORIZONS["7d"] + 1)).toEqual(["1h", "1d", "7d"]);
  });
  it("already-scored horizons are not due again (null counts as scored)", () => {
    const i = item({ ret_1h: 0.01, ret_1d: null });
    expect(dueHorizons(i, T0 + HORIZONS["7d"] + 1)).toEqual(["7d"]);
  });
  it("expires at 2x width", () => {
    expect(expiredHorizons(item(), T0 + 2 * HORIZONS["1h"] + 1)).toEqual(["1h"]);
    expect(expiredHorizons(item({ ret_1h: 0.01 }), T0 + 2 * HORIZONS["1h"] + 1)).toEqual([]);
  });
  it("completeness requires every horizon present (null ok)", () => {
    expect(isComplete(item())).toBe(false);
    expect(isComplete(item({ ret_1h: 0.01, ret_1d: null, ret_7d: -0.02 }))).toBe(true);
  });
});
