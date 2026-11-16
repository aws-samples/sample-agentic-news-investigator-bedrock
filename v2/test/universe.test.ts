// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { isFuturesSymbol, universeCheck } from "../src/universe.js";

const base = { universe: "prediction" as const, side: "buy" as const, notionalUsd: 1000, held: [], equityUsd: 100_000, futuresMaxPct: 0.2 };

describe("universe", () => {
  it("recognises futures symbols", () => {
    expect(isFuturesSymbol("CL=F")).toBe(true);
    expect(isFuturesSymbol("CLZ26.NYM")).toBe(true);
    expect(isFuturesSymbol("ZQV26.CBT")).toBe(true);
    expect(isFuturesSymbol("AAPL")).toBe(false);
    expect(isFuturesSymbol("7203.T")).toBe(false);
  });
  it("lets v2/v3 trade anything", () => {
    expect(universeCheck({ ...base, universe: "all", symbol: "AAPL" }).ok).toBe(true);
  });
  it("v5: contracts yes, stocks/FX/crypto no", () => {
    expect(universeCheck({ ...base, symbol: "fed-rate-hike-by-october-2026-meeting:YES" }).ok).toBe(true);
    expect(universeCheck({ ...base, symbol: "KXFEDDECISION-26OCT-H25:NO" }).ok).toBe(true);
    expect(universeCheck({ ...base, symbol: "AAPL" }).ok).toBe(false);
    expect(universeCheck({ ...base, symbol: "USDJPY" }).ok).toBe(false);
    expect(universeCheck({ ...base, symbol: "BTC-USD" }).ok).toBe(false);
  });
  it("v5: futures up to the gross cap; exits always allowed", () => {
    expect(universeCheck({ ...base, symbol: "CL=F", notionalUsd: 15_000, held: [{ symbol: "BZ=F", qty: -50, mark: 100 }] }).ok).toBe(true); // 5k + 15k = 20k
    expect(universeCheck({ ...base, symbol: "CL=F", notionalUsd: 15_001, held: [{ symbol: "BZ=F", qty: -50, mark: 100 }] }).ok).toBe(false);
    expect(universeCheck({ ...base, symbol: "AAPL", side: "sell", held: [{ symbol: "AAPL", qty: 3, mark: 300 }] }).ok).toBe(true);
  });
});
