// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { parseCriptoya, criptoyaFiat, FRESHNESS_SECS } from "../src/quotes/criptoya.js";

// Entry shapes captured live 2026-08-30 from /api/usdt/ars/1 (values trimmed).
const NOW = 1_790_000_000_000;
const fresh = NOW / 1000 - 60;
const stale = NOW / 1000 - 2 * 3600;

describe("parseCriptoya", () => {
  it("filters zero sides and stale outliers, takes medians", () => {
    const body = {
      buenbit: { ask: 1627.19, bid: 1590.61, time: fresh },
      fiwind: { ask: 1605.0, bid: 1592.0, time: fresh },
      ripio: { ask: 1610.0, bid: 1588.0, time: fresh },
      // no ask; only its bid may count
      huobi_noask: { ask: 0, bid: 1591.0, time: fresh },
      // ~30% off and 2h stale: must be excluded entirely
      huobip2p: { ask: 1122.5, bid: 1122.09, time: stale },
    };
    const q = parseCriptoya(body, "USDTARS", NOW)!;
    expect(q).not.toBeNull();
    expect(q.ask).toBe(1610.0); // median of [1605, 1610, 1627.19]
    expect(q.bid).toBeCloseTo(1590.805, 10); // median of [1588, 1590.61, 1591, 1592]
    expect(q.price).toBeCloseTo((1610.0 + 1590.805) / 2, 10);
    expect(q.source).toBe("criptoya");
    expect(q.kind).toBe("parallel_fx");
  });

  it("rejects when fewer than 2 venues survive per side", () => {
    const body = {
      only: { ask: 11.95, bid: 11.93, time: fresh },
      dead: { ask: 0, bid: 0, time: fresh },
    };
    expect(parseCriptoya(body, "USDTBOB", NOW)).toBeNull();
  });

  it("rejects empty and non-object bodies", () => {
    expect(parseCriptoya({}, "USDTARS", NOW)).toBeNull();
    expect(parseCriptoya(null, "USDTARS", NOW)).toBeNull();
  });

  it("freshness boundary is respected", () => {
    const border = NOW / 1000 - FRESHNESS_SECS - 1;
    const body = {
      a: { ask: 10, bid: 9, time: border },
      b: { ask: 10, bid: 9, time: border },
    };
    expect(parseCriptoya(body, "USDTBOB", NOW)).toBeNull();
  });

  it("maps symbols to fiats", () => {
    expect(criptoyaFiat("USDTARS")).toBe("ars");
    expect(criptoyaFiat("USDTBOB")).toBe("bob");
    expect(criptoyaFiat("EURUSD")).toBeNull();
    expect(criptoyaFiat("USDT")).toBeNull();
  });
});
