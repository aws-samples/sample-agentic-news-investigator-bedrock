// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { budgetAllows } from "../src/budget.js";
import { liquidityCap, liquidationPrice } from "../src/exec.js";
import { entryPrice, exitPrice, signedReturn } from "../src/score.js";
import { parsePolymarket } from "../src/quotes/prediction.js";
import { RecentActivity } from "../src/recent.js";
import { config } from "../src/config.js";

describe("budget reserve", () => {
  const base = { investigations: 10, dailyBudget: 50 };
  it("news stops at (1 - reserve) of budget; position management continues", () => {
    const cost = 50 * (1 - config.budgetReserveFraction) + 0.01; // just over $40
    expect(budgetAllows({ ...base, costUsd: cost, priority: false }).allowed).toBe(false);
    expect(budgetAllows({ ...base, costUsd: cost, priority: true }).allowed).toBe(true);
  });
  it("hard ceiling applies to everyone", () => {
    expect(budgetAllows({ ...base, costUsd: 50, priority: true }).allowed).toBe(false);
    expect(budgetAllows({ ...base, costUsd: 50, priority: false }).allowed).toBe(false);
  });
  it("under the news ceiling both are allowed", () => {
    expect(budgetAllows({ ...base, costUsd: 12, priority: false }).allowed).toBe(true);
  });
  it("investigation count cap applies to news only", () => {
    const many = { costUsd: 5, dailyBudget: 50, investigations: config.maxInvestigationsPerDay };
    expect(budgetAllows({ ...many, priority: false }).allowed).toBe(false);
    expect(budgetAllows({ ...many, priority: true }).allowed).toBe(true);
  });
});

describe("liquidity realism", () => {
  it("caps fills to a fraction of the resting book; unknown depth = no cap", () => {
    expect(liquidityCap(16)).toBeCloseTo(16 * config.maxFillLiquidityFraction);
    expect(liquidityCap(undefined)).toBeNull();
    expect(liquidityCap(0)).toBe(0);
  });
  it("values longs at the bid, not the mid (the 0.15/0.97 case)", () => {
    expect(liquidationPrice({ price: 0.56, bid: 0.15, ask: 0.97 })).toBe(0.15);
    expect(liquidationPrice({ price: 100 })).toBe(100); // no book
    expect(liquidationPrice({ price: 1, resolved: true, bid: 0.2 })).toBe(1); // payout wins
  });
  it("scorer uses round-trip prices", () => {
    const q = { price: 0.56, bid: 0.15, ask: 0.97 };
    expect(entryPrice(q, "buy")).toBe(0.97);
    expect(exitPrice(q, "buy")).toBe(0.15);
    expect(entryPrice(q, "sell")).toBe(0.15);
    expect(exitPrice(q, "sell")).toBe(0.97);
    expect(entryPrice(q, "hold")).toBe(0.97); // counterfactual buy
    // A "mid says +180%" trade is a loss round-trip.
    expect(signedReturn("buy", entryPrice({ price: 0.2, bid: 0.18, ask: 0.2 }, "buy"), exitPrice(q, "buy"))).toBeLessThan(0);
  });
});

describe("resolved polymarket market quotes at payout", () => {
  const body = [{ closed: true, outcomePrices: '["1", "0"]', bestBid: 0.99, bestAsk: 1, liquidityNum: 0 }];
  it("YES holder sees price 1, resolved, no book", () => {
    const q = parsePolymarket(body, "x:YES", true)!;
    expect(q.resolved).toBe(true);
    expect(q.price).toBe(1);
    expect(q.bid).toBeUndefined();
  });
  it("NO holder sees price 0", () => {
    expect(parsePolymarket(body, "x:NO", false)!.price).toBe(0);
  });
  it("open market carries liquidity depth", () => {
    const open = [{ closed: false, bestBid: 0.15, bestAsk: 0.97, outcomePrices: '["0.56","0.44"]', liquidityNum: 16 }];
    const q = parsePolymarket(open, "x:YES", true)!;
    expect(q.liquidityUsd).toBe(16);
    expect(q.resolved).toBeUndefined();
  });
});

describe("headline dedupe + recent history", () => {
  it("skips identical headlines inside the window, allows after it", () => {
    const r = new RecentActivity(3 * 3_600_000);
    const t0 = 1_790_000_000_000;
    const d = (headline: string) => ({ headline, source_family: "disaster" });
    expect(r.isDuplicate(d("Tropical Storm Edouard Graphics"), t0)).toBe(false);
    expect(r.isDuplicate(d("tropical storm  edouard graphics"), t0 + 60_000)).toBe(true);
    expect(r.isDuplicate(d("Tropical Storm Edouard Graphics"), t0 + 4 * 3_600_000)).toBe(false);
    expect(r.isDuplicate(d("Tropical Storm Edouard Public Advisory Number 7"), t0)).toBe(false);
  });
  it("summarizes recent investigations for triage", () => {
    const r = new RecentActivity();
    r.recordInvestigation("Storm advisory", [
      { action: "buy", symbol: "X:YES", notional_usd: 500, confidence: 0.6, rationale: "", evidence: [] },
      { action: "hold", confidence: 0.7, rationale: "", evidence: [], watch_symbol: "USO" },
    ]);
    const rec = r.recent();
    expect(rec).toHaveLength(1);
    expect(rec[0].outcome).toBe("buy X:YES $500; hold (watch USO)");
  });
});
