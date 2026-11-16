// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { clampMultiplier, liveMode } from "../src/config.js";
import { sizingNote, sizingUtilization, renderMandate } from "../src/mandate.js";
import { config } from "../src/config.js";

const util = { equityUsd: 10_000, deployedUsd: 3_000, deployedPct: 0.3, positions: 3 };

describe("V2_SIZING_MULTIPLIER", () => {
  it("is off (1) unless set to a finite number, and is clamped to [1, 10]", () => {
    expect(clampMultiplier(undefined)).toBe(1);
    expect(clampMultiplier("")).toBe(1);
    expect(clampMultiplier("nope")).toBe(1);
    expect(clampMultiplier("0.5")).toBe(1);
    expect(clampMultiplier("5")).toBe(5);
    expect(clampMultiplier("50")).toBe(10);
  });
  it("leaves the utilization and the book context untouched at 1", () => {
    expect(sizingUtilization(util, 1)).toBe(util);
    expect(sizingNote(10_000, 7_000, 1)).toBeNull();
  });
  it("scales the equity the agent sizes against and measures deployment against it", () => {
    const s = sizingUtilization(util, 5);
    expect(s.equityUsd).toBe(50_000);
    expect(s.deployedUsd).toBe(3_000); // real dollars
    expect(s.deployedPct).toBeCloseTo(0.06);
    expect(s.positions).toBe(3);
  });
  it("prints the ladder in scaled dollars and says cash is the limit", () => {
    const m = renderMandate(sizingUtilization(util, 5), [], config.mandate, new Date("2026-11-01T12:00:00Z"), "all");
    expect(m).toContain("equity $50,000");
    const note = sizingNote(10_000, 7_000, 5)!;
    expect(note).toContain("5× the account's $10,000");
    expect(note).toContain("$7,000 on hand");
  });
  it("does nothing without an equity figure", () => {
    const unknown = { ...util, equityUsd: null, deployedPct: null };
    expect(sizingUtilization(unknown, 5)).toBe(unknown);
    expect(sizingNote(null, null, 5)).toBeNull();
  });
  it("V2_LIVE is off unless it is exactly demo or prod", () => {
    expect(liveMode(undefined)).toBe("off");
    expect(liveMode("")).toBe("off");
    expect(liveMode("true")).toBe("off");
    expect(liveMode("PROD")).toBe("off");
    expect(liveMode("demo")).toBe("demo");
    expect(liveMode("prod")).toBe("prod");
  });
});
