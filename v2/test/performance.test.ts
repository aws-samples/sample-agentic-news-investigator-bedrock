// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { computePerf, pickBase } from "../src/performance.js";

const base = {
  seedCash: 100_000,
  inceptionMs: Date.parse("2026-08-30T20:54:43Z"),
  nowMs: Date.parse("2026-09-01T22:00:00Z"),
  fills: 9,
};

describe("computePerf", () => {
  it("reproduces the live book: return on seed, deployed share, reconciliation", () => {
    // The real 2026-09-01 book: two prediction positions marked at bid.
    const p = computePerf({
      ...base,
      cash: 95_450.46,
      positions: [
        { symbol: "TX", qty: 37_321, avgCost: 0.17148281128587123, mark: 0.15 },
        { symbol: "LA", qty: 15_000, avgCost: 0.18, mark: 0.12 },
      ],
      realizedToDate: 4_550.37,
      buyNotionalToDate: 19_099.54,
    });
    expect(p.equity).toBeCloseTo(95_450.46 + 37_321 * 0.15 + 15_000 * 0.12, 2);
    expect(p.totalReturnPct).toBeCloseTo(2.85, 1);
    // Only ~9% of the book is actually invested; the rest is idle cash.
    expect(p.deployedPct).toBeCloseTo(8.85, 1);
    expect(p.cashPct).toBeCloseTo(92.81, 1);
    // Cost basis and cash sum past 100% because the positions are underwater;
    // it is the MARK plus cash that must make up the whole book.
    expect(p.marketValuePct + p.cashPct).toBeCloseTo(100, 6);
    expect(p.days).toBeCloseTo(2.05, 1);
    // realized + unrealized must equal equity - seed, or the ledger drifted.
    expect(p.reconciles).toBe(true);
  });

  it("flags a book that does not reconcile", () => {
    const p = computePerf({
      ...base,
      cash: 100_000,
      positions: [],
      realizedToDate: 500, // claims a gain the cash balance does not show
      buyNotionalToDate: 1_000,
    });
    expect(p.totalPnl).toBe(0);
    expect(p.reconciles).toBe(false);
  });

  it("reports return on capital committed, not just on seed", () => {
    const p = computePerf({
      ...base,
      cash: 101_000,
      positions: [],
      realizedToDate: 1_000,
      buyNotionalToDate: 10_000,
    });
    expect(p.totalReturnPct).toBeCloseTo(1, 6); // 1% of the $100k account
    expect(p.returnOnCommittedPct).toBeCloseTo(10, 6); // 10% of the $10k risked
  });

  it("holds a zero-fill account at zero rather than dividing by zero", () => {
    const p = computePerf({
      ...base,
      cash: 100_000,
      positions: [],
      realizedToDate: 0,
      buyNotionalToDate: 0,
      fills: 0,
    });
    expect(p.returnOnCommittedPct).toBe(0);
    expect(p.reconciles).toBe(true);
  });
});

describe("pickBase", () => {
  const d = (iso: string, close: number) => ({ tMs: Date.parse(iso), close });

  it("uses the last close at or before inception (Friday for a Sunday seed)", () => {
    const closes = [
      d("2026-08-27T13:30:00Z", 100),
      d("2026-08-28T13:30:00Z", 101), // Friday
      d("2026-08-31T13:30:00Z", 105), // Monday, after a Sunday inception
    ];
    const picked = pickBase(closes, Date.parse("2026-08-30T20:54:43Z"));
    expect(picked?.base.close).toBe(101);
    expect(picked?.afterInception).toBe(false);
  });

  it("falls back to the first later close and flags it when history is too short", () => {
    const closes = [d("2026-09-01T13:30:00Z", 105)];
    const picked = pickBase(closes, Date.parse("2026-08-30T20:54:43Z"));
    expect(picked?.base.close).toBe(105);
    expect(picked?.afterInception).toBe(true);
  });

  it("returns null with no history at all", () => {
    expect(pickBase([], Date.now())).toBeNull();
  });
});
