// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { bookUtilization, renderMandate } from "../src/mandate.js";

const m = {
  minDeployedPct: 0.3,
  maxDeployedPct: 0.7,
  minPositions: 4,
  maxPositions: 12,
  maxPositionPct: 0.1,
  watchlistHours: 72,
};

describe("bookUtilization", () => {
  it("marks longs and shorts at the last watched price and counts gross exposure", () => {
    const u = bookUtilization({
      cash_usd: 90_000,
      positions: [
        { symbol: "AAA", qty: 5_000, avg_cost: 2, last_seen_price: 2.2 }, // long, 11,000
        { symbol: "BBB", qty: -100, avg_cost: 50, last_seen_price: 40 }, // short, -4,000 signed
        { symbol: "CCC", qty: 10, avg_cost: 100, last_seen_price: null }, // never watched: cost
      ],
    });
    expect(u.equityUsd).toBeCloseTo(90_000 + 11_000 - 4_000 + 1_000, 6);
    expect(u.deployedUsd).toBeCloseTo(11_000 + 4_000 + 1_000, 6);
    expect(u.deployedPct).toBeCloseTo(16_000 / 98_000, 6);
    expect(u.positions).toBe(3);
  });

  it("does not invent an equity figure when the ledger has no cash", () => {
    const u = bookUtilization({ cash_usd: null, positions: [] });
    expect(u.equityUsd).toBeNull();
    expect(u.deployedPct).toBeNull();
  });
});

describe("renderMandate", () => {
  const now = new Date("2026-09-04T18:00:00Z");

  it("tells an idle book how far under the floor it is, in dollars, with the ladder priced at its equity", () => {
    const text = renderMandate(
      bookUtilization({
        cash_usd: 93_720,
        positions: [{ symbol: "wti:YES", qty: 5_882, avg_cost: 0.34, last_seen_price: 0.32 }],
      }),
      [],
      m,
      now,
    );
    // equity 93,720 + 1,882 = 95,602; deployed 1,882 (2%); floor 30% = 28,681 → gap 26,798
    expect(text).toContain("deployed $1,882 (2%) in 1 position");
    expect(text).toContain("UNDER-DEPLOYED — $26,798 short of the 30% floor");
    expect(text).toContain("0.55 ≈ 1% ($956)");
    expect(text).toContain("cap 10% ($9,560)");
    expect(text).toContain("Watchlist: empty");
  });

  it("lists the watchlist as candidates with age, confidence and the reason it was left", () => {
    const text = renderMandate(
      bookUtilization({ cash_usd: 100_000, positions: [] }),
      [
        {
          symbol: "USDJPY",
          at: "2026-09-04T15:00:00Z",
          headline: "Japan PMI final August",
          rationale: "Yen weaker on soft PMI; no yen instrument held, watching USDJPY for 157",
          confidence: 0.8,
        },
      ],
      m,
      now,
    );
    expect(text).toContain("- USDJPY (3h ago, hold conf 0.80, on \"Japan PMI final August\"): Yen weaker");
    expect(text).toContain("live candidate in either direction");
  });

  it("says within mandate inside the band and warns above the ceiling", () => {
    const within = renderMandate(
      bookUtilization({ cash_usd: 50_000, positions: [{ symbol: "X", qty: 1, avg_cost: 50_000, last_seen_price: null }] }),
      [],
      m,
      now,
    );
    expect(within).toContain("Status: within the mandate.");
    const above = renderMandate(
      bookUtilization({ cash_usd: 10_000, positions: [{ symbol: "X", qty: 1, avg_cost: 90_000, last_seen_price: null }] }),
      [],
      m,
      now,
    );
    expect(above).toContain("ABOVE the 70% ceiling");
  });

  it("still prints the band and the watchlist when equity is unknown, without a status it cannot compute", () => {
    const text = renderMandate(bookUtilization({ cash_usd: null, positions: [] }), [], m, now);
    expect(text).toContain("equity unknown");
    expect(text).not.toContain("Status:");
    expect(text).not.toContain("Conviction →");
  });
});
