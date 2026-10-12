// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { isFxPair, inferKind, isLiquidFxPair, spreadBps, pickFxQuote } from "../src/quotes/resolver.js";

describe("resolver kind inference", () => {
  it("recognizes ISO fx pairs", () => {
    expect(isFxPair("EURUSD")).toBe(true);
    expect(isFxPair("USDJPY")).toBe(true);
    expect(isFxPair("USDNPR")).toBe(true); // quotable (indicative) — pegging is the agent's problem
    expect(isFxPair("USDJPYUSD")).toBe(false);
    expect(isFxPair("ABCXYZ")).toBe(false);
    expect(isFxPair("eurusd")).toBe(false); // normalization happens before this
  });

  it("infers kinds", () => {
    expect(inferKind("USDTARS")).toBe("parallel_fx");
    expect(inferKind("USDTBOB")).toBe("parallel_fx");
    expect(inferKind("EURUSD")).toBe("fx");
    expect(inferKind("BTC")).toBe("crypto");
    expect(inferKind("ARGT")).toBe("equity");
    expect(inferKind("some-slug:YES")).toBe("prediction");
    expect(inferKind("KXHURRICANE-7:NO")).toBe("prediction");
  });
});

describe("FX venue choice", () => {
  const q = (o: Partial<{ symbol: string; price: number; bid: number; ask: number; source: string }>) =>
    ({ symbol: "USDJPY", kind: "fx" as const, asOfMs: 0, source: "kraken", price: 155.8, ...o });
  it("knows which pairs have an interbank market", () => {
    expect(isLiquidFxPair("USDJPY")).toBe(true);
    expect(isLiquidFxPair("JPYUSD")).toBe(true);
    expect(isLiquidFxPair("USDNPR")).toBe(false);
  });
  it("measures the spread in bps", () => {
    expect(spreadBps({ price: 155.8, bid: 154.28, ask: 157.39 })!).toBeGreaterThan(190);
    expect(spreadBps({ price: 1.16, bid: 1.16216, ask: 1.16222 })!).toBeLessThan(1);
    expect(spreadBps({ price: 1 })).toBeNull();
  });
  it("keeps a tight exchange book", async () => {
    const r = await pickFxQuote("EURUSD", q({ symbol: "EURUSD", price: 1.1622, bid: 1.16216, ask: 1.16222 }) as any, async () => { throw new Error("should not fetch"); }, 10);
    expect(r!.quote.source).toBe("kraken");
    expect(r!.indicativeOnly).toBe(false);
  });
  it("replaces a 200 bps Kraken book on a major with the reference rate, tradeable", async () => {
    const r = await pickFxQuote("USDJPY", q({ bid: 154.28, ask: 157.39 }) as any, async () => q({ source: "yahoo", price: 155.84 }) as any, 10);
    expect(r!.quote.source).toBe("yahoo reference");
    expect(r!.quote.bid).toBeUndefined();
    expect(r!.indicativeOnly).toBe(false);
    expect(r!.note).toMatch(/not the market/);
  });
  it("makes the inverse pair expressible when only the reference quotes it", async () => {
    const r = await pickFxQuote("JPYUSD", null, async () => q({ symbol: "JPYUSD", source: "yahoo", price: 0.00642 }) as any, 10);
    expect(r!.indicativeOnly).toBe(false);
  });
  it("keeps exotic pairs indicative when they have no book", async () => {
    const r = await pickFxQuote("USDNPR", null, async () => q({ symbol: "USDNPR", source: "yahoo", price: 140 }) as any, 10);
    expect(r!.indicativeOnly).toBe(true);
  });
  it("keeps a wide book on an exotic pair — it is the only market there is", async () => {
    const r = await pickFxQuote("USDTRY", q({ symbol: "USDTRY", price: 41, bid: 40, ask: 42 }) as any, async () => { throw new Error("should not fetch"); }, 10);
    expect(r!.quote.source).toBe("kraken");
  });
});

describe("futures and international symbols", () => {
  it("infers futures and suffixed listings as Yahoo-quoted equities", () => {
    expect(inferKind("CL=F")).toBe("equity");
    expect(inferKind("7203.T")).toBe("equity");
    expect(inferKind("ES=F")).toBe("equity");
  });
});
