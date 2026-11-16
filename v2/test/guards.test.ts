// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from "vitest";
import { addsExposure, alertThresholdPct, dailySigmaPct, exposureAllowance, reviewRefusal } from "../src/guards.js";

describe("alert threshold", () => {
  it("is max(base, k·σ), and the base when off or unknown", () => {
    expect(alertThresholdPct(5, 6, 1.5)).toBeCloseTo(9);
    expect(alertThresholdPct(5, 2, 1.5)).toBe(5); // a quiet large cap keeps 5%
    expect(alertThresholdPct(5, 6, 0)).toBe(5);
    expect(alertThresholdPct(5, null, 1.5)).toBe(5);
  });
  it("computes daily σ from closes, needing 10+ returns", () => {
    const flat = Array.from({ length: 21 }, () => 100);
    expect(dailySigmaPct(flat)).toBe(0);
    const alt = Array.from({ length: 21 }, (_, i) => (i % 2 ? 105 : 100));
    expect(dailySigmaPct(alt)!).toBeGreaterThan(4.5);
    expect(dailySigmaPct([100, 101, 102])).toBeNull();
  });
});

describe("daily review, manage-only", () => {
  it("refuses opening or adding, allows exits and covers", () => {
    expect(reviewRefusal("daily-review", "buy", 0)).toMatch(/does not open/);
    expect(reviewRefusal("daily-review", "buy", 100)).toMatch(/does not open/);
    expect(reviewRefusal("daily-review", "sell", 0)).toMatch(/shorts/);
    expect(reviewRefusal("daily-review", "sell", 100)).toBeNull(); // exit/trim
    expect(reviewRefusal("daily-review", "buy", -50)).toBeNull(); // cover a short
  });
  it("leaves every other trigger alone", () => {
    expect(reviewRefusal("edgar", "buy", 0)).toBeNull();
    expect(reviewRefusal("sweep", "buy", 0)).toBeNull();
  });
});

describe("per-decision exposure cap", () => {
  it("knows what adds exposure", () => {
    expect(addsExposure("buy", 0)).toBe(true);
    expect(addsExposure("sell", 0)).toBe(true); // opens a short
    expect(addsExposure("sell", 10)).toBe(false);
    expect(addsExposure("buy", -10)).toBe(false);
  });
  it("caps the sum across a decision's actions (the 2026-11-03 Senate review: $10k in one go)", () => {
    // 6% of $104k = $6,240.
    expect(exposureAllowance(6, 104_000, 0, 5000)).toBe(5000);
    expect(exposureAllowance(6, 104_000, 5000, 3000)).toBeCloseTo(1240);
    expect(exposureAllowance(6, 104_000, 6240, 2000)).toBe(0);
    expect(exposureAllowance(0, 104_000, 99_999, 2000)).toBe(2000); // off
  });
});
