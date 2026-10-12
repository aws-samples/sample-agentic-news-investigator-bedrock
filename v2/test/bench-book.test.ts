// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { SimBook, FUTURE_QUOTE_TOLERANCE_MS } from "../src/bench/book.js";
import { bookUtilization } from "../src/mandate.js";
import { config } from "../src/config.js";
import type { Quote, TradeDecision } from "../src/types.js";

// A book clock deliberately far from wall time: every quote below is "old" by
// Date.now(), so a rule measured against the wrong clock shows up immediately.
const T0 = Date.parse("2025-03-03T15:00:00Z");

function quote(symbol: string, over: Partial<Quote> = {}): Quote {
  return {
    symbol,
    kind: "equity",
    price: 100,
    bid: 100,
    ask: 100,
    asOfMs: T0,
    source: "test",
    ...over,
  };
}

type Extra = Partial<Omit<TradeDecision, "action">>;
function buy(symbol: string, notional_usd: number, extra: Extra = {}) {
  return { action: "buy" as const, symbol, notional_usd, confidence: 0.6, rationale: "t", evidence: [], ...extra };
}
function sell(symbol: string, notional_usd: number, extra: Extra = {}) {
  return { action: "sell" as const, symbol, notional_usd, confidence: 0.6, rationale: "t", evidence: [], ...extra };
}

function filled(o: ReturnType<SimBook["apply"]>) {
  if (o.status !== "filled") throw new Error(`expected fill, got ${o.reason}: ${o.detail}`);
  return o.fill;
}
function droppedReason(o: ReturnType<SimBook["apply"]>): string {
  if (o.status !== "dropped") throw new Error("expected drop, got fill");
  return o.reason;
}

describe("SimBook fills", () => {
  it("buy then partial sell: averages in, realizes on the way out, deletes at zero, moves cash by qty*fillPrice", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const f1 = filled(b.apply(buy("AAPL", 10_000), quote("AAPL"), "d1"));
    expect(f1).toMatchObject({ symbol: "AAPL", side: "buy", qty: 100, fillPrice: 100, notionalUsd: 10_000, slippageBps: 0, decisionId: "d1", atMs: T0, realizedPnl: 0 });
    expect(b.cash).toBe(90_000);
    expect(b.positions).toEqual([{ symbol: "AAPL", kind: "equity", qty: 100, avg_cost: 100, last_seen_price: 100 }]);

    const f2 = filled(b.apply(sell("AAPL", 4_000), quote("AAPL"), "d2"));
    expect(f2.qty).toBe(40);
    expect(b.cash).toBe(94_000);
    expect(b.positions[0]).toMatchObject({ qty: 60, avg_cost: 100 });

    // Sell 20 more at 110: realized (110-100)*20 = 200; avg cost unchanged.
    const f3 = filled(b.apply(sell("AAPL", 2_200), quote("AAPL", { price: 110, bid: 110, ask: 110 }), "d3"));
    expect(f3.qty).toBe(20);
    expect(f3.realizedPnl).toBeCloseTo(200, 6);
    expect(b.cash).toBeCloseTo(96_200, 6);
    expect(b.realizedPnl).toBeCloseTo(200, 6);
    expect(b.positions[0]).toMatchObject({ qty: 40, avg_cost: 100 });

    // Close the rest: the position row disappears.
    filled(b.apply(sell("AAPL", 4_000), quote("AAPL"), "d4"));
    expect(b.positions).toEqual([]);
    expect(b.fills).toHaveLength(4);
    expect(b.fills.map((f) => f.decisionId)).toEqual(["d1", "d2", "d3", "d4"]);
  });

  it("crosses the spread: buys at the ask, sells at the bid, 2 bps adverse with no book", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const f = filled(b.apply(buy("X", 1_010), quote("X", { bid: 99, ask: 101 }), "d"));
    expect(f.fillPrice).toBe(101);
    expect(f.qty).toBe(10);
    expect(f.slippageBps).toBeCloseTo(100);
    // A long is marked at the bid the moment it fills: cash 98,990 + 10 * 99 = 99,980 — the spread is lost on entry.
    expect(b.equity()).toBeCloseTo(99_980, 6);

    const nb = new SimBook({ cash: 100_000, nowMs: T0 });
    const g = filled(nb.apply(buy("FXPAIR", 1_000), quote("FXPAIR", { kind: "fx", price: 100, bid: undefined, ask: undefined }), "d"));
    expect(g.fillPrice).toBeCloseTo(100.02);
    expect(g.slippageBps).toBeCloseTo(2);
  });

  it("refuses a one-sided book on the missing side", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    expect(droppedReason(b.apply(buy("X", 100), quote("X", { bid: 99, ask: undefined }), "d"))).toBe("dropped_empty_book");
    expect(b.cash).toBe(100_000);
  });

  it("honours the agent's limit_price", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    expect(droppedReason(b.apply(buy("X", 100, { limit_price: 99 }), quote("X"), "d"))).toBe("limit_not_met");
    expect(droppedReason(b.apply(sell("X", 100, { limit_price: 101 }), quote("X"), "d"))).toBe("limit_not_met");
    filled(b.apply(buy("X", 100, { limit_price: 100 }), quote("X"), "d"));
  });

  it("drops bad notionals and resolved markets", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    expect(droppedReason(b.apply(buy("X", 0), quote("X"), "d"))).toBe("bad_notional");
    expect(droppedReason(b.apply(buy("X", NaN), quote("X"), "d"))).toBe("bad_notional");
    expect(droppedReason(b.apply(buy("m:YES", 100), quote("m:YES", { kind: "prediction", price: 1, bid: undefined, ask: undefined, resolved: true }), "d"))).toBe("market_resolved");
  });
});

describe("SimBook shorts", () => {
  it("a sell beyond what is held opens a short for shortable kinds only", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const f = filled(b.apply(sell("TSLA", 5_000), quote("TSLA"), "d1"));
    expect(f.qty).toBe(50);
    expect(b.positions).toEqual([{ symbol: "TSLA", kind: "equity", qty: -50, avg_cost: 100, last_seen_price: 100 }]);
    expect(b.cash).toBe(105_000); // proceeds credited, as the ledger does

    const crypto = filled(b.apply(sell("BTC", 1_000), quote("BTC", { kind: "crypto" }), "d2"));
    expect(crypto.qty).toBe(10);
    const fx = filled(b.apply(sell("USDJPY", 1_000), quote("USDJPY", { kind: "fx" }), "d3"));
    expect(fx.qty).toBe(10);

    const pred = b.apply(sell("wti:YES", 100), quote("wti:YES", { kind: "prediction", price: 0.5, bid: 0.5, ask: 0.5, liquidityUsd: 10_000 }), "d4");
    expect(droppedReason(pred)).toBe("not_shortable");
    expect((pred as { detail?: string }).detail).toContain("wti:NO");
    const par = b.apply(sell("USDTBOB", 100), quote("USDTBOB", { kind: "parallel_fx", price: 10, bid: 10, ask: 10 }), "d5");
    expect(droppedReason(par)).toBe("not_shortable");
    expect((par as { detail?: string }).detail).toContain("one-sided");
  });

  it("selling down a long is not a short and needs no collateral check", () => {
    const b = new SimBook({ cash: 100, nowMs: T0 });
    filled(b.apply(buy("X", 100), quote("X"), "d1"));
    // Book equity is 100; a $60 sale of a held long is a reduction, not a short.
    filled(b.apply(sell("X", 60), quote("X"), "d2"));
    expect(b.positions[0]).toMatchObject({ qty: 0.4 });
  });

  it("short exposure at entry prices may not exceed book equity (no leverage)", () => {
    const b = new SimBook({ cash: 10_000, nowMs: T0 });
    expect(droppedReason(b.apply(sell("X", 20_000), quote("X"), "d1"))).toBe("insufficient_collateral");
    expect(b.positions).toEqual([]);
    filled(b.apply(sell("X", 9_000), quote("X"), "d2")); // 9,000 <= 10,000
    // Adding: shortAfter = 90*100 (existing at cost) + 20*100 (new) = 11,000 vs equity 19,000 - 9,000 = 10,000.
    const more = b.apply(sell("X", 2_000), quote("X"), "d3");
    expect(droppedReason(more)).toBe("insufficient_collateral");
    expect((more as { detail?: string }).detail).toMatch(/\$11000 would exceed book equity \$10000/);
    // Another symbol counts toward the same total.
    expect(droppedReason(b.apply(sell("Y", 1_500), quote("Y"), "d4"))).toBe("insufficient_collateral");
    filled(b.apply(sell("Y", 1_000), quote("Y"), "d5")); // exactly at the ceiling
  });

  it("flips through zero: the closed leg realizes, the remainder is a short at the fill price", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    filled(b.apply(buy("X", 10_000), quote("X"), "d1"));
    const f = filled(b.apply(sell("X", 15_000), quote("X"), "d2"));
    expect(f.qty).toBe(150);
    expect(b.positions).toEqual([{ symbol: "X", kind: "equity", qty: -50, avg_cost: 100, last_seen_price: 100 }]);
    expect(b.cash).toBe(105_000);
  });

  it("a buy against a short covers it", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    filled(b.apply(sell("X", 10_000), quote("X"), "d1"));
    const cover = filled(b.apply(buy("X", 9_000), quote("X", { price: 90, bid: 90, ask: 90 }), "d2"));
    expect(cover.qty).toBe(100);
    expect(cover.realizedPnl).toBeCloseTo(1_000, 6); // (100-90)*100
    expect(b.positions).toEqual([]);
    expect(b.cash).toBeCloseTo(101_000, 6);
  });
});

describe("SimBook cash and liquidity", () => {
  it("cash never goes negative: the buy is dropped and nothing changes", () => {
    const b = new SimBook({ cash: 1_000, nowMs: T0 });
    const o = b.apply(buy("X", 1_500), quote("X"), "d");
    expect(droppedReason(o)).toBe("insufficient_cash");
    expect(b.cash).toBe(1_000);
    expect(b.positions).toEqual([]);
    expect(b.fills).toEqual([]);
    // Exactly all the cash is fine.
    filled(b.apply(buy("X", 1_000), quote("X"), "d2"));
    expect(b.cash).toBe(0);
  });

  it("caps the fill to config.maxFillLiquidityFraction of the visible book and records the request", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const f = filled(b.apply(buy("m:YES", 2_000), quote("m:YES", { kind: "prediction", price: 0.5, bid: 0.5, ask: 0.5, liquidityUsd: 1_000 }), "d"));
    const cap = 1_000 * config.maxFillLiquidityFraction; // 250
    expect(f.liquidityCapped).toEqual({ requested: 2_000, bookUsd: 1_000 });
    expect(f.notionalUsd).toBeCloseTo(cap, 6);
    expect(f.qty).toBe(Math.floor(cap / 0.5));
    // No cap when the venue does not report depth.
    const g = filled(b.apply(buy("X", 2_000), quote("X"), "d2"));
    expect(g.liquidityCapped).toBeUndefined();
    expect(g.notionalUsd).toBe(2_000);
  });

  it("drops a fill the book cannot absorb at all", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    expect(droppedReason(b.apply(buy("m:YES", 100), quote("m:YES", { kind: "prediction", price: 0.5, bid: 0.5, ask: 0.5, liquidityUsd: 2 }), "d"))).toBe("dropped_illiquid");
  });

  it("prediction contracts fill in whole units; too little notional is zero_qty", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const f = filled(b.apply(buy("m:YES", 100), quote("m:YES", { kind: "prediction", price: 0.34, bid: 0.34, ask: 0.34, liquidityUsd: 50_000 }), "d"));
    expect(f.qty).toBe(294);
    expect(f.notionalUsd).toBeCloseTo(294 * 0.34, 6);
    expect(b.cash).toBeCloseTo(100_000 - 294 * 0.34, 6);
    expect(droppedReason(b.apply(buy("m:YES", 0.2), quote("m:YES", { kind: "prediction", price: 0.34, bid: 0.34, ask: 0.34 }), "d2"))).toBe("zero_qty");
  });
});

describe("SimBook clock", () => {
  it("measures quote staleness against the book clock, not wall time", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    // 5 minutes old at book time — accepted although it is ~18 months old by Date.now().
    filled(b.apply(buy("X", 100), quote("X", { asOfMs: T0 - 5 * 60_000 }), "d1"));
    // Just past the limit at book time.
    const stale = b.apply(buy("X", 100), quote("X", { asOfMs: T0 - (config.maxQuoteAgeSecs + 1) * 1000 }), "d2");
    expect(droppedReason(stale)).toBe("dropped_stale_quote");
    expect((stale as { detail?: string }).detail).toContain(`${config.maxQuoteAgeSecs + 1}s old`);
    // Advance the clock and the same quote is now stale.
    b.setClock(T0 + 30 * 60_000);
    expect(droppedReason(b.apply(buy("X", 100), quote("X"), "d3"))).toBe("dropped_stale_quote");
    // A fresh quote at the new clock fills, and the fill is stamped with the book clock.
    const f = filled(b.apply(buy("X", 100), quote("X", { asOfMs: T0 + 29 * 60_000 }), "d4"));
    expect(f.atMs).toBe(T0 + 30 * 60_000);
  });

  it("refuses a quote from the future beyond the tolerance (lookahead)", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    filled(b.apply(buy("X", 100), quote("X", { asOfMs: T0 + FUTURE_QUOTE_TOLERANCE_MS }), "d1"));
    expect(droppedReason(b.apply(buy("X", 100), quote("X", { asOfMs: T0 + FUTURE_QUOTE_TOLERANCE_MS + 1 }), "d2"))).toBe("dropped_future_quote");
  });
});

describe("SimBook marks, equity, snapshot, context", () => {
  function seeded() {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    filled(b.apply(buy("AAPL", 10_000), quote("AAPL"), "d1")); // long 100 @ 100, cash 90,000
    filled(b.apply(sell("TSLA", 5_000), quote("TSLA"), "d2")); // short 50 @ 100, cash 95,000
    return b;
  }

  it("marks longs at the bid and shorts at the ask; unknown symbols are left alone", () => {
    const b = seeded();
    b.mark({
      AAPL: quote("AAPL", { price: 100, bid: 95, ask: 105 }),
      TSLA: quote("TSLA", { price: 100, bid: 95, ask: 105 }),
      NOPE: quote("NOPE", { price: 1 }),
    });
    const by = Object.fromEntries(b.positions.map((p) => [p.symbol, p]));
    expect(by.AAPL.last_seen_price).toBe(95);
    expect(by.TSLA.last_seen_price).toBe(105);
    expect(b.positions).toHaveLength(2);
    // No book: the mid is all there is.
    b.mark({ AAPL: quote("AAPL", { price: 97, bid: undefined, ask: undefined }) });
    expect(b.positions.find((p) => p.symbol === "AAPL")!.last_seen_price).toBe(97);
  });

  it("equity is cash plus signed marks at liquidation value", () => {
    const b = seeded();
    expect(b.equity()).toBeCloseTo(100_000, 6); // 95,000 + 10,000 - 5,000
    b.mark({
      AAPL: quote("AAPL", { price: 100, bid: 95, ask: 105 }),
      TSLA: quote("TSLA", { price: 100, bid: 95, ask: 105 }),
    });
    // 95,000 + 100*95 - 50*105 = 99,250: both sides lose the spread.
    expect(b.equity()).toBeCloseTo(99_250, 6);
    // The empty book is just cash.
    expect(new SimBook({ cash: 42, nowMs: T0 }).equity()).toBe(42);
  });

  it("snapshot has the pipeline's shape and feeds bookUtilization unchanged", () => {
    const b = seeded();
    b.mark({ AAPL: quote("AAPL", { bid: 95, ask: 105 }), TSLA: quote("TSLA", { bid: 95, ask: 105 }) });
    const snap = b.snapshot();
    expect(Object.keys(snap).sort()).toEqual(["cash_usd", "positions"]);
    expect(snap.cash_usd).toBe(95_000);
    for (const p of snap.positions) {
      expect(Object.keys(p).sort()).toEqual(["avg_cost", "kind", "last_seen_price", "qty", "symbol"]);
    }
    expect(snap.positions).toEqual([
      { symbol: "AAPL", kind: "equity", qty: 100, avg_cost: 100, last_seen_price: 95 },
      { symbol: "TSLA", kind: "equity", qty: -50, avg_cost: 100, last_seen_price: 105 },
    ]);
    const u = bookUtilization(snap);
    expect(u.equityUsd).toBeCloseTo(b.equity(), 6);
    expect(u.deployedUsd).toBeCloseTo(100 * 95 + 50 * 105, 6);
    expect(u.positions).toBe(2);
    // The snapshot is a copy: mutating it does not touch the book.
    snap.cash_usd = 0;
    snap.positions.length = 0;
    expect(b.cash).toBe(95_000);
    expect(b.positions).toHaveLength(2);
  });

  it("renderContext is the snapshot JSON followed by the mandate block, ages against the book clock, held symbols dropped from the watchlist", () => {
    const empty = new SimBook({ cash: 100_000, nowMs: T0 });
    const ctx = empty.renderContext();
    const [first, ...rest] = ctx.split("\n");
    expect(JSON.parse(first)).toEqual(empty.snapshot());
    expect(rest[0]).toMatch(/^Mandate \(deployment\): equity \$100,000; deployed \$0 \(0%\) in 0 positions\./);
    expect(ctx).toContain("UNDER-DEPLOYED");
    expect(ctx).toContain("Conviction → size at current equity");
    expect(ctx).toContain("Watchlist: empty");

    const b = seeded();
    const three = new Date(T0 - 3 * 3_600_000).toISOString();
    const withWatch = b.renderContext([
      { symbol: "USDJPY", at: three, headline: "Japan PMI", rationale: "yen weaker", confidence: 0.8 },
      { symbol: "AAPL", at: three, headline: "held already", rationale: "x", confidence: 0.9 },
    ]);
    expect(withWatch).toContain("- USDJPY (3h ago, hold conf 0.80");
    expect(withWatch).not.toContain("held already");
    expect(withWatch).toContain("in 2 positions");
  });
});

describe("SimBook construction", () => {
  it("rejects a negative or non-finite seed", () => {
    expect(() => new SimBook({ cash: -1, nowMs: T0 })).toThrow(/non-negative/);
    expect(() => new SimBook({ cash: NaN, nowMs: T0 })).toThrow(/non-negative/);
  });
});

describe("SimBook reduce-only and capped reductions (mirror of exec.ts)", () => {
  it("reports the position before the fill and caps a reduction to 25% of the visible book", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    const o1 = b.apply(buy("Q", 1_000), quote("Q", { liquidityUsd: 100_000 }), "d1");
    expect(o1).toMatchObject({ status: "filled", positionBefore: 0 });
    const o2 = b.apply(sell("Q", 1_000), quote("Q", { liquidityUsd: 400 }), "d2");
    expect(o2).toMatchObject({ status: "filled", positionBefore: 10 });
    const f2 = filled(o2);
    expect(f2.notionalUsd).toBeCloseTo(100); // 25% of a $400 book
    expect(f2.liquidityCapped).toEqual({ requested: 1_000, bookUsd: 400 });
    expect(b.positions[0]).toMatchObject({ qty: 9 });
  });

  it("a reduce-only order never exceeds the position and is refused once it is gone", () => {
    const b = new SimBook({ cash: 100_000, nowMs: T0 });
    filled(b.apply(buy("TSLA", 500), quote("TSLA"), "d1")); // 5 shares
    const f = filled(b.apply(sell("TSLA", 5_000, { reduce_only: true }), quote("TSLA"), "d2"));
    expect(f.qty).toBe(5); // not the 50 the notional implies
    expect(b.positions).toEqual([]);
    expect(droppedReason(b.apply(sell("TSLA", 5_000, { reduce_only: true }), quote("TSLA"), "d3"))).toBe("position_closed");
    // Without the flag the same order opens a short; a reduce-only buy then covers at most that short.
    expect(filled(b.apply(sell("TSLA", 5_000), quote("TSLA"), "d4")).qty).toBe(50);
    const cover = filled(b.apply(buy("TSLA", 9_000, { reduce_only: true }), quote("TSLA"), "d5"));
    expect(cover.qty).toBe(50);
    expect(b.positions).toEqual([]);
    expect(b.cash).toBeCloseTo(100_000, 6);
  });
});
