// SPDX-License-Identifier: MIT-0
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseChartBars, intervalForAge, type Bar } from "../src/quotes/yahoo.js";
import {
  yahooChartSymbol,
  resolveAsOf,
  historicalReturn,
  MAX_CLOSURE_MS,
  type TapeQuoteLike,
} from "../src/quotes/asof.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A bars dependency that behaves like Yahoo: returns the fixture bars inside the requested window. */
function barsFrom(fixture: Partial<Record<"1m" | "60m" | "1d", Bar[]>>) {
  return vi.fn(async (_sym: string, o: { interval: string; startMs: number; endMs: number }) =>
    (fixture[o.interval as "1m" | "60m" | "1d"] ?? []).filter((b) => b.tMs >= o.startMs && b.tMs <= o.endMs),
  );
}
const bar = (tMs: number, close: number): Bar => ({ tMs, open: close, high: close, low: close, close });

describe("parseChartBars", () => {
  // Shape verified live 2026-09-04: timestamp[] is the bar open; quote arrays line up; null = no trade.
  const body = {
    chart: {
      result: [
        {
          meta: { symbol: "AAPL" },
          timestamp: [1_756_990_200, 1_756_993_800, 1_756_997_400],
          indicators: {
            quote: [
              {
                open: [230.1, null, 231.0],
                high: [231.5, null, 231.9],
                low: [229.8, null, 230.4],
                close: [231.2, null, 231.7],
                volume: [1_200_000, null, null],
              },
            ],
          },
        },
      ],
    },
  };

  it("maps timestamps (seconds) to bars and skips null closes", () => {
    const bars = parseChartBars(body);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      tMs: 1_756_990_200_000,
      open: 230.1,
      high: 231.5,
      low: 229.8,
      close: 231.2,
      volume: 1_200_000,
    });
    expect(bars[1].tMs).toBe(1_756_997_400_000);
    expect(bars[1].close).toBe(231.7);
    expect(bars[1]).not.toHaveProperty("volume");
  });

  it("falls back to the close when open/high/low are missing", () => {
    const b = parseChartBars({
      chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [5] }] } }] },
    });
    expect(b).toEqual([{ tMs: 1000, open: 5, high: 5, low: 5, close: 5 }]);
  });

  it("returns no bars for error and empty payloads", () => {
    expect(parseChartBars({ chart: { result: null, error: { code: "Not Found" } } })).toEqual([]);
    expect(parseChartBars({})).toEqual([]);
    expect(parseChartBars(null)).toEqual([]);
  });
});

describe("intervalForAge", () => {
  it("1m within 7 days, 60m within 60 days, else 1d", () => {
    expect(intervalForAge(0)).toBe("1m");
    expect(intervalForAge(7 * DAY)).toBe("1m");
    expect(intervalForAge(7 * DAY + 1)).toBe("60m");
    expect(intervalForAge(60 * DAY)).toBe("60m");
    expect(intervalForAge(60 * DAY + 1)).toBe("1d");
    expect(intervalForAge(400 * DAY)).toBe("1d");
  });
});

describe("yahooChartSymbol", () => {
  it("maps each kind to Yahoo's chart symbol", () => {
    expect(yahooChartSymbol("EURUSD", "fx")).toBe("EURUSD=X");
    expect(yahooChartSymbol("EURUSD", "auto")).toBe("EURUSD=X");
    expect(yahooChartSymbol("eurusd")).toBe("EURUSD=X");
    expect(yahooChartSymbol("BTC", "crypto")).toBe("BTC-USD");
    expect(yahooChartSymbol("BTC")).toBe("BTC-USD");
    expect(yahooChartSymbol("OM", "crypto")).toBe("OM-USD"); // long tail: explicit kind, not in KNOWN_CRYPTO
    expect(yahooChartSymbol("AAPL", "equity")).toBe("AAPL");
    expect(yahooChartSymbol("AAPL")).toBe("AAPL");
    expect(yahooChartSymbol("CL=F")).toBe("CL=F");
    expect(yahooChartSymbol("7203.T")).toBe("7203.T");
    expect(yahooChartSymbol("VOD.L", "equity")).toBe("VOD.L");
  });

  it("has nothing for parallel rates and prediction contracts", () => {
    expect(yahooChartSymbol("USDTARS")).toBeNull();
    expect(yahooChartSymbol("USDTARS", "parallel_fx")).toBeNull();
    expect(yahooChartSymbol("some-slug:YES")).toBeNull();
    expect(yahooChartSymbol("KXHURRICANE-7:NO", "prediction")).toBeNull();
  });
});

describe("resolveAsOf", () => {
  // Bench-shaped moment: a Tuesday 15:00 UTC, nine days before "now" (the 60m regime).
  const asOf = Date.UTC(2026, 7, 25, 15, 0, 0);
  const now = asOf + 9 * DAY;
  const tapeRow = (o: Partial<TapeQuoteLike> = {}): TapeQuoteLike => ({
    symbol: "AAPL",
    kind: "equity",
    price: 231.0,
    bid: 230.9,
    ask: 231.1,
    asOfMs: asOf - 5 * MIN,
    source: "kraken",
    hasBook: true,
    ageSecs: 12,
    indicativeOnly: false,
    captured_at: new Date(asOf - 5 * MIN + 12_000).toISOString(),
    ...o,
  });

  it("never touches the live resolver: only inferKind/isLiquidFxPair are imported from resolver.ts", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/quotes/asof.ts", import.meta.url)), "utf8");
    const m = /import\s*\{([^}]*)\}\s*from\s*"\.\/resolver\.js"/.exec(src);
    expect(m).not.toBeNull();
    const names = m![1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    expect(names).not.toContain("resolve");
    expect(names).toContain("inferKind");
    expect(src).not.toMatch(/import\s*\*\s*as\s+\w+\s+from\s*"\.\/resolver\.js"/);
  });

  it("prefers the tape when it answers, with age against the moment and no bars fetched", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - 2 * HOUR, 999)] });
    const tape = vi.fn(async () => tapeRow());
    const r = await resolveAsOf("AAPL", "equity", asOf, { tape, bars, nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.price).toBe(231.0);
    expect(r.quote.bid).toBe(230.9);
    expect(r.quote.ask).toBe(231.1);
    expect(r.quote.source).toBe("kraken");
    expect(r.meta.hasBook).toBe(true);
    expect(r.meta.ageSecs).toBe(300);
    expect(r.meta.note).toContain("tape");
    expect(tape).toHaveBeenCalledWith("AAPL", asOf);
    expect(bars).not.toHaveBeenCalled();
  });

  it("falls to bars when the tape has nothing, taking the last bar completed at or before the moment", async () => {
    const bars = barsFrom({
      "60m": [
        bar(asOf - 3 * HOUR, 100),
        bar(asOf - 2 * HOUR, 101), // opened 13:00, complete 14:00 -> the answer
        bar(asOf - 30 * MIN, 102), // opened 14:30, still forming at 15:00: its close is the future
        bar(asOf + HOUR, 103), // after the moment; a Yahoo-like dependency would not even return it
      ],
    });
    const r = await resolveAsOf("AAPL", "equity", asOf, { tape: async () => null, bars, nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.price).toBe(101);
    // Stamped at the bar's CLOSE (13:00 bar closes 14:00): that is when the price was knowable.
    expect(r.quote.asOfMs).toBe(asOf - HOUR);
    expect(r.quote.source).toBe("yahoo-asof:60m");
    expect(r.quote.bid).toBeUndefined();
    expect(r.quote.ask).toBeUndefined();
    expect(r.meta.hasBook).toBe(false);
    expect(r.meta.ageSecs).toBe(3600);
    expect(r.meta.barSpanSecs).toBe(3600);
    expect(r.meta.note).toMatch(/historical 60m bar/);
    expect(r.meta.note).toMatch(/depth and spread unknown/);
    expect(bars).toHaveBeenCalledTimes(1);
    const call = bars.mock.calls[0]![1];
    expect(call.interval).toBe("60m");
    expect(call.endMs).toBe(asOf);
    expect(call.startMs).toBeLessThan(asOf - MAX_CLOSURE_MS);
  });

  it("uses a bar exactly one span before the moment (the boundary is inclusive)", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - HOUR, 55)] });
    const r = await resolveAsOf("AAPL", "equity", asOf, { bars, nowMs: now });
    expect(r.ok && r.quote.price).toBe(55);
  });

  it("works without a tape dependency at all", async () => {
    const r = await resolveAsOf("AAPL", "equity", asOf, { bars: barsFrom({ "60m": [bar(asOf - HOUR, 7)] }), nowMs: now });
    expect(r.ok && r.quote.price).toBe(7);
  });

  it("survives a weekend: Friday's last bar answers a Monday-morning moment", async () => {
    const monday = Date.UTC(2026, 7, 24, 10, 0, 0); // Monday 10:00 UTC, pre-open
    const friday = Date.UTC(2026, 7, 21, 19, 30, 0); // Friday's last hourly bar
    const r = await resolveAsOf("AAPL", "equity", monday, {
      bars: barsFrom({ "60m": [bar(friday, 42)] }),
      nowMs: monday + 9 * DAY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.price).toBe(42);
    expect(r.meta.ageSecs).toBe((monday - (friday + HOUR)) / 1000);
  });

  it("refuses when the only bar is older than a market closure", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - 10 * DAY, 100)], "1d": [bar(asOf - 10 * DAY, 100)] });
    const r = await resolveAsOf("FLZH", "equity", asOf, { tape: async () => null, bars, nowMs: now });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(`no historical quote for FLZH as of ${new Date(asOf).toISOString()}`);
  });

  it("refuses a bar whose close is after the moment even when it is the only one", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - 10 * MIN, 100)] });
    const r = await resolveAsOf("AAPL", "equity", asOf, { bars, nowMs: now });
    expect(r.ok).toBe(false);
  });

  it("uses minute bars for a recent moment and falls through to hourly bars across an overnight gap", async () => {
    const recent = asOf + 8 * DAY; // one day before now: the 1m regime
    const bars = barsFrom({
      "1m": [], // venue was closed for the whole 1m lookback
      "60m": [bar(recent - 20 * HOUR, 88)],
    });
    const r = await resolveAsOf("AAPL", "equity", recent, { bars, nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.source).toBe("yahoo-asof:60m");
    expect(r.quote.price).toBe(88);
    expect(bars.mock.calls.map((c) => c[1].interval)).toEqual(["1m", "60m"]);
    expect(bars.mock.calls[0]![1].startMs).toBe(recent - DAY);
  });

  it("uses minute bars when they exist, with the 1m source", async () => {
    const recent = asOf + 8 * DAY;
    const bars = barsFrom({ "1m": [bar(recent - 3 * MIN, 12.5), bar(recent - MIN, 12.6)] });
    const r = await resolveAsOf("BTC", "auto", recent, { bars, nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.price).toBe(12.6);
    expect(r.quote.kind).toBe("crypto");
    expect(r.quote.source).toBe("yahoo-asof:1m");
    expect(r.meta.ageSecs).toBe(0); // the bar that closed exactly at the moment
    expect(r.meta.barSpanSecs).toBe(60);
    expect(bars.mock.calls[0]![0]).toBe("BTC-USD");
  });

  it("uses daily bars for an old moment and reports the 1d source", async () => {
    const old = now - 100 * DAY;
    const bars = barsFrom({ "1d": [bar(old - 2 * DAY, 3.1), bar(old - DAY, 3.2), bar(old - HOUR, 3.3)] });
    const r = await resolveAsOf("CL=F", "equity", old, { bars, nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.price).toBe(3.2); // the bar opened 1h before the moment has not closed yet
    expect(r.quote.source).toBe("yahoo-asof:1d");
    expect(bars.mock.calls[0]![0]).toBe("CL=F");
    expect(bars.mock.calls[0]![1].interval).toBe("1d");
  });

  it("prefers a later bar over a stale tape row, and the tape row over no bar", async () => {
    const stale = tapeRow({ asOfMs: asOf - 2 * DAY, captured_at: new Date(asOf - 2 * DAY).toISOString(), price: 200 });
    const fresh = barsFrom({ "60m": [bar(asOf - HOUR, 210)] });
    const r1 = await resolveAsOf("AAPL", "equity", asOf, { tape: async () => stale, bars: fresh, nowMs: now });
    expect(r1.ok && r1.quote.price).toBe(210);
    expect(r1.ok && r1.quote.source).toBe("yahoo-asof:60m");
    const r2 = await resolveAsOf("AAPL", "equity", asOf, { tape: async () => stale, bars: barsFrom({}), nowMs: now });
    expect(r2.ok && r2.quote.price).toBe(200);
    expect(r2.ok && r2.quote.source).toBe("kraken");
    expect(r2.ok && r2.meta.ageSecs).toBe(2 * DAY / 1000);
  });

  it("ignores a tape row captured after the moment (lookahead) or older than a closure", async () => {
    const later = tapeRow({ asOfMs: asOf + MIN, captured_at: new Date(asOf + MIN).toISOString() });
    const r1 = await resolveAsOf("AAPL", "equity", asOf, { tape: async () => later, bars: barsFrom({}), nowMs: now });
    expect(r1.ok).toBe(false);
    const ancient = tapeRow({ asOfMs: asOf - 6 * DAY, captured_at: new Date(asOf - 6 * DAY).toISOString() });
    const r2 = await resolveAsOf("AAPL", "equity", asOf, { tape: async () => ancient, bars: barsFrom({}), nowMs: now });
    expect(r2.ok).toBe(false);
  });

  it("treats a tape failure as no tape, not as a reason to stop", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - HOUR, 9)] });
    const tape = async () => {
      throw new Error("dynamo down");
    };
    const r = await resolveAsOf("AAPL", "equity", asOf, { tape, bars, nowMs: now });
    expect(r.ok && r.quote.price).toBe(9);
  });

  it("refuses prediction contracts and parallel rates without a tape, and never asks Yahoo", async () => {
    const bars = barsFrom({ "60m": [bar(asOf - HOUR, 0.5)], "1d": [bar(asOf - HOUR, 0.5)] });
    const p = await resolveAsOf("some-slug:YES", "auto", asOf, { bars, nowMs: now });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/no historical quote for some-slug:YES as of/);
    const px = await resolveAsOf("USDTARS", "parallel_fx", asOf, { tape: async () => null, bars, nowMs: now });
    expect(px.ok).toBe(false);
    expect(bars).not.toHaveBeenCalled();
  });

  it("serves prediction contracts and parallel rates from the tape", async () => {
    const row = tapeRow({
      symbol: "some-slug:YES",
      kind: "prediction",
      price: 0.31,
      bid: 0.3,
      ask: 0.32,
      source: "polymarket",
      liquidityUsd: 1500,
    });
    const r = await resolveAsOf("some-slug:YES", "auto", asOf, { tape: async () => row, bars: barsFrom({}), nowMs: now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.kind).toBe("prediction");
    expect(r.quote.liquidityUsd).toBe(1500);
    expect(r.quote.source).toBe("polymarket");
  });

  it("refuses a moment in the future", async () => {
    const bars = barsFrom({ "1m": [bar(now, 1)] });
    const r = await resolveAsOf("AAPL", "equity", now + MIN, { bars, nowMs: now });
    expect(r.ok).toBe(false);
    expect(bars).not.toHaveBeenCalled();
  });

  it("marks an FX reference bar indicative only for non-majors, as the live path does", async () => {
    const usdjpy = await resolveAsOf("USDJPY", "auto", asOf, { bars: barsFrom({ "60m": [bar(asOf - HOUR, 147.2)] }), nowMs: now });
    expect(usdjpy.ok && usdjpy.meta.indicativeOnly).toBe(false);
    expect(usdjpy.ok && usdjpy.quote.kind).toBe("fx");
    const usdnpr = await resolveAsOf("USDNPR", "auto", asOf, { bars: barsFrom({ "60m": [bar(asOf - HOUR, 140.1)] }), nowMs: now });
    expect(usdnpr.ok && usdnpr.meta.indicativeOnly).toBe(true);
  });
});

describe("historicalReturn", () => {
  const entry = Date.UTC(2026, 7, 25, 15, 0, 0);
  const now = entry + 9 * DAY;
  const fixture = {
    "60m": [
      bar(entry - HOUR, 100), // entry: the last completed bar before the moment
      bar(entry + DAY - HOUR, 110), // exit for the 1d horizon
      bar(entry + 7 * DAY - HOUR, 80), // exit for the 7d horizon
    ],
  };

  it("is positive for a buy that went up and reports both sides and sources", async () => {
    const r = await historicalReturn("AAPL", "equity", "buy", entry, DAY, { bars: barsFrom(fixture), nowMs: now });
    expect(r).not.toBeNull();
    expect(r!.entry).toBe(100);
    expect(r!.exit).toBe(110);
    expect(r!.ret).toBeCloseTo(0.1);
    expect(r!.entrySource).toBe("yahoo-asof:60m");
    expect(r!.exitSource).toBe("yahoo-asof:60m");
  });

  it("is positive for a sell that went down, negative for a buy that went down", async () => {
    const sell = await historicalReturn("AAPL", "equity", "sell", entry, 7 * DAY, { bars: barsFrom(fixture), nowMs: now });
    expect(sell!.ret).toBeCloseTo(0.2);
    const buy = await historicalReturn("AAPL", "equity", "buy", entry, 7 * DAY, { bars: barsFrom(fixture), nowMs: now });
    expect(buy!.ret).toBeCloseTo(-0.2);
  });

  it("scores a hold as the counterfactual long", async () => {
    const r = await historicalReturn("AAPL", "equity", "hold", entry, DAY, { bars: barsFrom(fixture), nowMs: now });
    expect(r!.ret).toBeCloseTo(0.1);
  });

  it("enters at the ask and exits at the bid when the tape has a book", async () => {
    const rows: Record<number, TapeQuoteLike> = {
      [entry]: {
        symbol: "AAPL", kind: "equity", price: 100, bid: 99, ask: 101, asOfMs: entry - MIN, source: "kraken",
        hasBook: true, ageSecs: 5, indicativeOnly: false, captured_at: new Date(entry - MIN).toISOString(),
      },
      [entry + DAY]: {
        symbol: "AAPL", kind: "equity", price: 110, bid: 109, ask: 111, asOfMs: entry + DAY - MIN, source: "kraken",
        hasBook: true, ageSecs: 5, indicativeOnly: false, captured_at: new Date(entry + DAY - MIN).toISOString(),
      },
    };
    const tape = async (_s: string, t: number) => rows[t] ?? null;
    const buy = await historicalReturn("AAPL", "equity", "buy", entry, DAY, { tape, bars: barsFrom({}), nowMs: now });
    expect(buy!.entry).toBe(101);
    expect(buy!.exit).toBe(109);
    expect(buy!.entrySource).toBe("kraken");
    const sell = await historicalReturn("AAPL", "equity", "sell", entry, DAY, { tape, bars: barsFrom({}), nowMs: now });
    expect(sell!.entry).toBe(99);
    expect(sell!.exit).toBe(111);
    expect(sell!.ret).toBeCloseTo(-(111 / 99 - 1));
  });

  it("scores a venue closed for the whole horizon as a flat round trip on the same bar", async () => {
    // The entry bar is still the last completed one a day later (within the closure bound): nothing traded.
    const r = await historicalReturn("AAPL", "equity", "buy", entry, DAY, {
      bars: barsFrom({ "60m": [bar(entry - HOUR, 100)] }),
      nowMs: now,
    });
    expect(r).toEqual({ entry: 100, exit: 100, ret: 0, entrySource: "yahoo-asof:60m", exitSource: "yahoo-asof:60m" });
  });

  it("is null when the exit is missing, when the entry is missing, and when the horizon has not elapsed", async () => {
    const noExit = barsFrom({ "60m": [bar(entry - HOUR, 100)] }); // past the closure bound at entry + 7d
    expect(await historicalReturn("AAPL", "equity", "buy", entry, 7 * DAY, { bars: noExit, nowMs: now })).toBeNull();
    const noEntry = barsFrom({ "60m": [bar(entry + DAY - HOUR, 110)] });
    expect(await historicalReturn("AAPL", "equity", "buy", entry, DAY, { bars: noEntry, nowMs: now })).toBeNull();
    const bars = barsFrom(fixture);
    expect(await historicalReturn("AAPL", "equity", "buy", entry, 10 * DAY, { bars, nowMs: now })).toBeNull();
    expect(bars).not.toHaveBeenCalled();
  });
});
