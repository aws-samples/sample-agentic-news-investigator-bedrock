// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  quoteKey,
  marketKey,
  marketId,
  toTapeQuote,
  ttlEpoch,
  snapshotSymbols,
  type TapeOrigin,
} from "../src/tape.js";
import type { Resolution, ResolvedInstrument } from "../src/types.js";

const CAPTURED = "2026-09-04T14:30:00.000Z";

const fullRes: ResolvedInstrument = {
  ok: true,
  quote: {
    symbol: "USDJPY",
    kind: "fx",
    price: 156.42,
    bid: 156.41,
    ask: 156.43,
    asOfMs: Date.parse("2026-09-04T14:29:58.000Z"),
    source: "yahoo reference",
    liquidityUsd: 12_000,
    resolved: false,
  },
  meta: {
    hasBook: true,
    ageSecs: 2,
    indicativeOnly: false,
    note: "kraken book 191 bps wide — not the market for a major; using the interbank reference",
  },
};

const bareRes: ResolvedInstrument = {
  ok: true,
  quote: { symbol: "USDTBOB", kind: "parallel_fx", price: 11.9, asOfMs: 1_790_000_000_000, source: "criptoya" },
  meta: { hasBook: false, ageSecs: 40, indicativeOnly: false },
};

describe("quoteKey", () => {
  it("sorts two captures a minute apart in time order under the TS# prefix", () => {
    const a = quoteKey("CL=F", "2026-09-04T14:30:00.000Z");
    const b = quoteKey("CL=F", "2026-09-04T14:31:00.000Z");
    expect(a.pk).toBe("QUOTE#CL=F");
    expect(b.pk).toBe(a.pk);
    expect(a.sk).toBe("TS#2026-09-04T14:30:00.000Z");
    expect(a.sk < b.sk).toBe(true);
    // and a day boundary still orders correctly (the as-of Query relies on this)
    expect(quoteKey("X", "2026-09-04T23:59:59.999Z").sk < quoteKey("X", "2026-09-05T00:00:00.000Z").sk).toBe(true);
  });
});

describe("marketKey / marketId", () => {
  it("keys a Polymarket hit by its slug, not the :YES symbol", () => {
    expect(marketId({ symbol: "will-a-hurricane-hit-texas-2026:YES" })).toBe("will-a-hurricane-hit-texas-2026");
    expect(marketKey("will-a-hurricane-hit-texas-2026", CAPTURED)).toEqual({
      pk: "MARKET#will-a-hurricane-hit-texas-2026",
      sk: `TS#${CAPTURED}`,
    });
  });
  it("falls back to the whole symbol when there is no side suffix", () => {
    expect(marketId({ symbol: "odd-symbol" })).toBe("odd-symbol");
  });
});

describe("toTapeQuote", () => {
  it("carries the quote and meta fields, stamps origin/arm/news_id, and derives the TTL from captured_at", () => {
    const row = toTapeQuote(fullRes, { newsId: "n-1", origin: "tool", arm: "v3", capturedAt: CAPTURED });
    expect(row).toMatchObject({
      symbol: "USDJPY",
      kind: "fx",
      price: 156.42,
      bid: 156.41,
      ask: 156.43,
      asOfMs: Date.parse("2026-09-04T14:29:58.000Z"),
      source: "yahoo reference",
      liquidityUsd: 12_000,
      resolved: false,
      hasBook: true,
      ageSecs: 2,
      indicativeOnly: false,
      captured_at: CAPTURED,
      news_id: "n-1",
      origin: "tool",
      arm: "v3",
    });
    expect(row.note).toContain("interbank reference");
    expect(row.expires_at).toBe(ttlEpoch(Date.parse(CAPTURED)));
  });

  it("omits optional fields that the resolver did not supply", () => {
    const row = toTapeQuote(bareRes, { origin: "watch", arm: "v2", capturedAt: CAPTURED });
    for (const k of ["bid", "ask", "liquidityUsd", "resolved", "note", "news_id"]) {
      expect(k in row, `${k} should be absent`).toBe(false);
    }
    expect(row.hasBook).toBe(false);
    expect(row.indicativeOnly).toBe(false);
    expect(row.ageSecs).toBe(40);
    expect(row.origin).toBe("watch");
    expect(row.arm).toBe("v2");
  });
});

describe("ttlEpoch", () => {
  it("is 90 days out by default, in whole epoch seconds", () => {
    const now = Date.parse("2026-09-04T14:30:00.500Z");
    expect(ttlEpoch(now)).toBe(Math.floor(now / 1000) + 90 * 86_400);
    expect(ttlEpoch(now) - Math.floor(now / 1000)).toBe(7_776_000);
    expect(Number.isInteger(ttlEpoch(now))).toBe(true);
  });
  it("honours an explicit horizon", () => {
    expect(ttlEpoch(0, 1)).toBe(86_400);
  });
});

describe("snapshotSymbols", () => {
  type Ctx = { newsId?: string; origin: TapeOrigin };

  function fakeResolver(table: Record<string, Resolution | "hang">) {
    const asked: string[] = [];
    const resolveFn = (async (symbol: string): Promise<Resolution> => {
      asked.push(symbol);
      const r = table[symbol];
      if (r === "hang") return new Promise<Resolution>(() => {});
      return r ?? { ok: false, reason: `${symbol}: unknown` };
    }) as unknown as typeof import("../src/quotes/resolver.js").resolve;
    return { asked, resolveFn };
  }

  function recorder() {
    const calls: { symbol: string; ctx: Ctx }[] = [];
    const record = async (res: ResolvedInstrument, ctx: Ctx) => {
      calls.push({ symbol: res.quote.symbol, ctx });
    };
    return { calls, record };
  }

  it("records each resolved symbol with origin ingest and the news id, skipping the unresolved", async () => {
    const { asked, resolveFn } = fakeResolver({
      USDJPY: fullRes,
      USDTBOB: bareRes,
      NOPE: { ok: false, reason: "NOPE: no Yahoo quote" },
    });
    const { calls, record } = recorder();
    const out = await snapshotSymbols(["USDJPY", "NOPE", "USDTBOB"], "n-42", { resolveFn, record, timeoutMs: 2_000 });
    expect(asked.sort()).toEqual(["NOPE", "USDJPY", "USDTBOB"]);
    expect(out.sort()).toEqual(["USDJPY", "USDTBOB"]);
    expect(calls.map((c) => c.symbol).sort()).toEqual(["USDJPY", "USDTBOB"]);
    for (const c of calls) expect(c.ctx).toEqual({ newsId: "n-42", origin: "ingest" });
  });

  it("dedupes, trims and caps at max", async () => {
    const table: Record<string, Resolution> = {};
    for (const s of ["A", "B", "C", "D", "E", "F", "G", "H"]) {
      table[s] = { ...bareRes, quote: { ...bareRes.quote, symbol: s } };
    }
    const { asked, resolveFn } = fakeResolver(table);
    const { calls, record } = recorder();
    const out = await snapshotSymbols([" A ", "A", "B", "C", "D", "E", "F", "G", "H"], "n-cap", {
      resolveFn,
      record,
      max: 3,
      timeoutMs: 2_000,
    });
    expect(asked).toEqual(["A", "B", "C"]);
    expect(out.sort()).toEqual(["A", "B", "C"]);
    expect(calls).toHaveLength(3);
  });

  it("returns what resolved by the deadline when a resolver never settles", async () => {
    const { resolveFn } = fakeResolver({ USDJPY: fullRes, STUCK: "hang" });
    const { calls, record } = recorder();
    const started = Date.now();
    const out = await snapshotSymbols(["USDJPY", "STUCK"], "n-hang", { resolveFn, record, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(out).toEqual(["USDJPY"]);
    expect(calls.map((c) => c.symbol)).toEqual(["USDJPY"]);
  });

  it("returns an empty list for no symbols without touching the resolver", async () => {
    const { asked, resolveFn } = fakeResolver({});
    const { calls, record } = recorder();
    expect(await snapshotSymbols(["", "  "], "n-empty", { resolveFn, record })).toEqual([]);
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("swallows a throwing resolver and still returns the others", async () => {
    const resolveFn = (async (symbol: string): Promise<Resolution> => {
      if (symbol === "BOOM") throw new Error("venue down");
      return fullRes;
    }) as unknown as typeof import("../src/quotes/resolver.js").resolve;
    const { calls, record } = recorder();
    const out = await snapshotSymbols(["BOOM", "USDJPY"], "n-boom", { resolveFn, record, timeoutMs: 2_000 });
    expect(out).toEqual(["USDJPY"]);
    expect(calls).toHaveLength(1);
  });
});
