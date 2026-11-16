// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from "vitest";
import { executeLive, reconcile, type LiveDeps } from "../src/live/broker.js";
import { DEFAULT_LIVE_LIMITS } from "../src/live/limits.js";
import { KalshiError } from "../src/live/kalshi-client.js";

const BOOK = { orderbook_fp: { yes_dollars: [["0.4000", "500.00"]], no_dollars: [["0.5800", "500.00"]] } }; // YES 0.40 / 0.42

function fakeDeps(over: Partial<LiveDeps> & { positions?: any; createOrder?: (o: any) => Promise<any> } = {}) {
  const orders: any[] = [];
  const fills: any[] = [];
  const deps: LiveDeps = {
    client: {
      orderbook: async () => BOOK,
      balance: async () => ({ balance: 50_000 }), // cents
      positions: async () => over.positions ?? { market_positions: [] },
      createOrder: over.createOrder ?? (async (o: any) => {
        orders.push(o);
        return { order_id: "ord-1", fill_count: o.count, remaining_count: "0.00", average_fill_price: o.side === "bid" ? "0.4200" : "0.4000", average_fee_paid: "0.0171" };
      }),
    },
    halted: async () => null,
    dayStartEquity: async (e) => e,
    ledgerPosition: async () => null,
    recordFill: async (f) => void fills.push(f),
    limits: DEFAULT_LIVE_LIMITS,
    slippageTolerance: 0.02,
    now: () => new Date("2026-10-30T12:00:00Z"),
    ...over,
  };
  return { deps, orders, fills };
}
const buyYes = { action: "buy" as const, symbol: "KXA-26NOV:YES", notional_usd: 2000, confidence: 0.6, rationale: "t" } as any;

describe("live broker", () => {
  it("places one IOC bid capped by the limits and mirrors the real fill with its fee", async () => {
    const { deps, orders, fills } = fakeDeps();
    const out = await executeLive(buyYes, "nws_1#1", "nws_1", deps);
    expect(out.status).toBe("filled");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ ticker: "KXA-26NOV", side: "bid", price: "0.4400", count: "113.00", time_in_force: "immediate_or_cancel" }); // $50 / 0.44
    expect(fills[0]).toMatchObject({ symbol: "KXA-26NOV:YES", qty: 113, fillPrice: 0.4371 }); // 0.42 + 0.0171 fee
    if (out.status === "filled") expect(out.liquidityCapped).toBeDefined(); // $49 of the $2,000 asked
  });

  it("halts when the kill switch says so, or cannot be read", async () => {
    expect(await executeLive(buyYes, "a", "n", fakeDeps({ halted: async () => "switch on" }).deps)).toMatchObject({ status: "dropped", reason: "live_halted" });
    expect(await executeLive(buyYes, "a", "n", fakeDeps({ halted: async () => { throw new Error("ssm down"); } }).deps)).toMatchObject({ status: "dropped", reason: "live_halted" });
  });

  it("refuses non-Kalshi symbols and the opposite side of a held market", async () => {
    expect(await executeLive({ ...buyYes, symbol: "some-slug:YES" }, "a", "n", fakeDeps().deps)).toMatchObject({ reason: "live_kalshi_only" });
    const holdingNo = fakeDeps({ positions: { market_positions: [{ ticker: "KXA-26NOV", position_fp: "-30.00", market_exposure_dollars: "17.40" }] } });
    expect(await executeLive(buyYes, "a", "n", holdingNo.deps)).toMatchObject({ reason: "live_opposite_side_held" });
    expect(holdingNo.orders).toHaveLength(0);
  });

  it("respects the agent's own limit price", async () => {
    expect(await executeLive({ ...buyYes, limit_price: 0.41 }, "a", "n", fakeDeps().deps)).toMatchObject({ reason: "limit_not_met" });
  });

  it("sells NO as a reduce-only bid on the YES book, capped by what the exchange holds", async () => {
    const { deps, orders } = fakeDeps({ positions: { market_positions: [{ ticker: "KXA-26NOV", position_fp: "-30.00", market_exposure_dollars: "17.40" }] } });
    const out = await executeLive({ action: "sell", symbol: "KXA-26NOV:NO", notional_usd: 1000, confidence: 0.6, rationale: "exit" } as any, "x#1", "x", deps);
    expect(out.status).toBe("filled");
    expect(orders[0]).toMatchObject({ side: "bid", reduce_only: true, count: "30.00" });
  });

  it("treats a duplicate client order id as already submitted, never a second trade", async () => {
    const dup = fakeDeps({ createOrder: async () => { throw new KalshiError(409, "duplicate client_order_id", "/portfolio/events/orders"); } });
    expect(await executeLive(buyYes, "a", "n", dup.deps)).toMatchObject({ reason: "live_duplicate" });
    expect(dup.fills).toHaveLength(0);
  });

  it("reports an IOC that filled nothing", async () => {
    const none = fakeDeps({ createOrder: async () => ({ order_id: "o", fill_count: "0.00", remaining_count: "0.00" }) });
    expect(await executeLive(buyYes, "a", "n", none.deps)).toMatchObject({ reason: "live_no_fill" });
  });
});

describe("reconcile", () => {
  it("lists Kalshi symbols where the ledger and the exchange disagree", () => {
    const diff = reconcile(
      [{ symbol: "KXA:YES", qty: 10 }, { symbol: "KXB:NO", qty: 5 }, { symbol: "slug:YES", qty: 3 }],
      new Map([["KXA:YES", 10], ["KXB:NO", 4], ["KXC:YES", 2]]),
    );
    expect(diff).toEqual([
      { symbol: "KXB:NO", ledger: 5, exchange: 4 },
      { symbol: "KXC:YES", ledger: 0, exchange: 2 },
    ]);
  });
});
