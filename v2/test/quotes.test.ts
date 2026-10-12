// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { parseKrakenTicker } from "../src/quotes/kraken.js";
import { parseChartMeta } from "../src/quotes/yahoo.js";
import { parseKalshiMarket, parsePolymarket, splitSide } from "../src/quotes/prediction.js";

describe("kraken", () => {
  // Internal-key shape verified live 2026-08-30: USDJPY -> ZUSDZJPY.
  const body = {
    error: [],
    result: {
      ZUSDZJPY: { a: ["161.912", "1", "1.000"], b: ["161.886", "1", "1.000"], c: ["161.899", "0.1"] },
    },
  };

  it("parses fx ticker with the internal pair key, symbol unmangled", () => {
    const q = parseKrakenTicker(body, "USDJPY", "fx")!;
    expect(q.symbol).toBe("USDJPY");
    expect(q.bid).toBeCloseTo(161.886);
    expect(q.ask).toBeCloseTo(161.912);
    expect(q.price).toBeCloseTo((161.886 + 161.912) / 2);
    expect(q.kind).toBe("fx");
  });

  it("treats kraken error arrays as no quote", () => {
    expect(parseKrakenTicker({ error: ["EQuery:Unknown asset pair"] }, "NZDUSD", "fx")).toBeNull();
  });
});

describe("yahoo", () => {
  it("parses chart meta (NZDUSD=X shape, verified 2026-08-30)", () => {
    const body = {
      chart: {
        result: [
          { meta: { regularMarketPrice: 0.5916, regularMarketTime: 1788119091, instrumentType: "CURRENCY" } },
        ],
      },
    };
    const m = parseChartMeta(body)!;
    expect(m.price).toBe(0.5916);
    expect(m.asOfMs).toBe(1788119091000);
    expect(m.instrumentType).toBe("CURRENCY");
  });

  it("returns null on error/empty payloads", () => {
    expect(parseChartMeta({ chart: { result: null, error: { code: "Not Found" } } })).toBeNull();
    expect(parseChartMeta({})).toBeNull();
  });
});

describe("prediction", () => {
  it("splits sides case-insensitively", () => {
    expect(splitSide("ABC-1:YES")).toEqual({ id: "ABC-1", yes: true });
    expect(splitSide("some-slug:no")).toEqual({ id: "some-slug", yes: false });
    expect(splitSide("ABC-1")).toBeNull();
    expect(splitSide("ABC-1:MAYBE")).toBeNull();
  });

  it("parses kalshi *_dollars fields (shape captured 2026-08-01)", () => {
    const body = {
      market: {
        ticker: "KXHURRICANE-26DEC01EPACMAJ-7",
        yes_bid_dollars: "0.2300",
        yes_ask_dollars: "0.3000",
        no_bid_dollars: "0.7000",
        no_ask_dollars: "0.7700",
        last_price_dollars: "0.3400",
      },
    };
    const q = parseKalshiMarket(body, "KXHURRICANE-26DEC01EPACMAJ-7:YES", true)!;
    expect(q.price).toBeCloseTo(0.265);
    expect(q.ask).toBeCloseTo(0.3);
    const qn = parseKalshiMarket(body, "KXHURRICANE-26DEC01EPACMAJ-7:NO", false)!;
    expect(qn.ask).toBeCloseTo(0.77);
  });

  it("parses polymarket YES book and complements NO (shape captured 2026-08-01)", () => {
    const body = [
      { question: "?", outcomePrices: '["0.245", "0.755"]', bestBid: 0.24, bestAsk: 0.25, closed: false },
    ];
    const q = parsePolymarket(body, "cat4-landfall:YES", true)!;
    expect(q.price).toBeCloseTo(0.245);
    const qn = parsePolymarket(body, "cat4-landfall:NO", false)!;
    expect(qn.bid).toBeCloseTo(0.75);
    expect(qn.ask).toBeCloseTo(0.76);
  });

  it("empty polymarket result is null", () => {
    expect(parsePolymarket([], "nope:YES", true)).toBeNull();
  });
});
