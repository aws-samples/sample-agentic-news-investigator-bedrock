// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_LIMITS, sizeLiveOrder, type LiveState } from "../src/live/limits.js";

const state = (over: Partial<LiveState> = {}): LiveState => ({
  cashUsd: 500,
  equityUsd: 500,
  dayStartEquityUsd: 500,
  positionCostUsd: new Map(),
  heldCount: 0,
  ...over,
});
const buy = (desiredUsd: number, price = 0.5, symbol = "KXA:YES") => ({ symbol, action: "buy" as const, desiredUsd, price });

describe("live limits", () => {
  it("caps a buy at the per-order limit and reports what bound it", () => {
    const r = sizeLiveOrder(buy(2000), state(), DEFAULT_LIVE_LIMITS);
    expect(r).toMatchObject({ ok: true, count: 100, usd: 50 });
    expect(r.ok && r.capped.join(" ")).toContain("max order");
  });

  it("caps by the position and deployment limits", () => {
    expect(sizeLiveOrder(buy(50), state({ positionCostUsd: new Map([["KXA:YES", 80]]) }), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 40 });
    expect(sizeLiveOrder(buy(50, 0.5, "KXB:YES"), state({ positionCostUsd: new Map([["KXA:YES", 390]]) }), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 20 });
    expect(sizeLiveOrder(buy(50), state({ positionCostUsd: new Map([["KXA:YES", 100]]) }), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: false });
  });

  it("keeps fee room in cash", () => {
    expect(sizeLiveOrder(buy(50), state({ cashUsd: 20 }), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 38 }); // 19.40 / 0.5
  });

  it("refuses buys outside the price band and after the daily loss stop", () => {
    expect(sizeLiveOrder(buy(50, 0.98), state(), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: false });
    expect(sizeLiveOrder(buy(50, 0.03), state(), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: false });
    const r = sizeLiveOrder(buy(50), state({ equityUsd: 440 }), DEFAULT_LIVE_LIMITS);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("daily loss stop");
  });

  it("never blocks an exit, and sells all when asked for ~all", () => {
    const losing = state({ equityUsd: 300, heldCount: 120 });
    expect(sizeLiveOrder({ symbol: "KXA:YES", action: "sell", desiredUsd: 1000, price: 0.98 }, losing, DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 120 });
    expect(sizeLiveOrder({ symbol: "KXA:YES", action: "sell", desiredUsd: 57, price: 0.5 }, losing, DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 120 }); // 114 ≥ 95% of 120
    expect(sizeLiveOrder({ symbol: "KXA:YES", action: "sell", desiredUsd: 20, price: 0.5 }, losing, DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: true, count: 40 });
    expect(sizeLiveOrder({ symbol: "KXA:YES", action: "sell", desiredUsd: 20, price: 0.5 }, state(), DEFAULT_LIVE_LIMITS)).toMatchObject({ ok: false });
  });
});
