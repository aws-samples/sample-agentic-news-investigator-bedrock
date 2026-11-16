// SPDX-License-Identifier: MIT-0
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  asksFor,
  bidsFor,
  clientOrderIdFor,
  exchangePositions,
  fromCreateOrderResponse,
  kalshiFee,
  parseKalshiSymbol,
  parseOrderbook,
  toCreateOrder,
  walkBook,
} from "../src/live/kalshi-core.js";
import { signKalshi } from "../src/live/kalshi-client.js";
import { shadowOf } from "../src/live/shadow.js";

// The live production book for KXFEDDECISION-26DEC-H0 on 2026-10-30 (depth 3), as the API returns it.
const FED = { orderbook_fp: { no_dollars: [["0.6900", "532.72"], ["0.7000", "230.00"], ["0.7100", "50000.00"]], yes_dollars: [["0.2500", "50016.88"], ["0.2600", "79.44"], ["0.2700", "7204.55"]] } };

describe("kalshi symbols and fees", () => {
  it("parses only Kalshi contract symbols", () => {
    expect(parseKalshiSymbol("KXFEDDECISION-26DEC-H0:NO")).toEqual({ ticker: "KXFEDDECISION-26DEC-H0", side: "NO" });
    expect(parseKalshiSymbol("KXWTI-26OCT2614-T102.99:YES")).toEqual({ ticker: "KXWTI-26OCT2614-T102.99", side: "YES" });
    expect(parseKalshiSymbol("SENATEMI-26-D:YES")).toEqual({ ticker: "SENATEMI-26-D", side: "YES" }); // no KX prefix
    expect(parseKalshiSymbol("us-iran-hormuz-agreement-by-november-30:NO")).toBeNull();
    expect(parseKalshiSymbol("26-10:YES")).toBeNull(); // needs a letter
    expect(parseKalshiSymbol("AAPL")).toBeNull();
  });

  it("charges 0.07·C·P·(1−P) rounded up to the cent, per order", () => {
    expect(kalshiFee(100, 0.5)).toBe(1.75);
    expect(kalshiFee(1, 0.5)).toBe(0.02); // 1.75c rounds up: small orders pay proportionally more
    expect(kalshiFee(3703, 0.54)).toBe(64.39); // 0.07 × 3703 × 0.2484 = 64.388 → up
    expect(kalshiFee(10, 0)).toBe(0);
    expect(kalshiFee(0, 0.5)).toBe(0);
  });
});

describe("order book", () => {
  const book = parseOrderbook(FED);

  it("sorts each side best first and derives asks from the other side", () => {
    expect(book.yesBids[0]).toEqual({ price: 0.27, qty: 7204.55 });
    expect(book.noBids[0]).toEqual({ price: 0.71, qty: 50000 });
    expect(asksFor(book, "YES")[0].price).toBe(0.29); // YES ask = 1 − best NO bid
    expect(asksFor(book, "NO")[0].price).toBe(0.73); // NO ask = 1 − best YES bid
    expect(bidsFor(book, "NO")[0].price).toBe(0.71);
  });

  it("walks a buy by dollars, whole contracts, inside the limit, with the fee", () => {
    const w = walkBook(asksFor(book, "YES"), { action: "buy", maxUsd: 100 });
    expect(w.count).toBe(344); // floor(100 / 0.29)
    expect(w.avgPrice).toBe(0.29);
    expect(w.fee).toBe(kalshiFee(344, 0.29));
    expect(w.effectivePrice).toBeGreaterThan(0.29);
    expect(walkBook(asksFor(book, "YES"), { action: "buy", maxUsd: 100, limit: 0.28 }).count).toBe(0);
  });

  it("walks a sell by contracts and stops at the floor", () => {
    const w = walkBook(bidsFor(book, "YES"), { action: "sell", maxCount: 7300 });
    expect(w.count).toBe(7300); // 7204 at 0.27, 79 at 0.26, 17 at 0.25
    expect(w.levelsUsed).toBe(3);
    expect(w.effectivePrice).toBeLessThan(w.avgPrice);
    expect(walkBook(bidsFor(book, "YES"), { action: "sell", maxCount: 7300, limit: 0.27 }).count).toBe(7204);
  });
});

describe("V2 order mapping (one book: bid buys YES, ask sells YES)", () => {
  const base = { ticker: "KXT", count: 10.7 };
  it("maps all four side/action combinations, NO on the YES book at 1 − q", () => {
    expect(toCreateOrder({ ...base, side: "YES", action: "buy", limitPrice: 0.42 }, "id")).toMatchObject({ side: "bid", price: "0.4200", count: "10.00", reduce_only: false, time_in_force: "immediate_or_cancel" });
    expect(toCreateOrder({ ...base, side: "YES", action: "sell", limitPrice: 0.42 }, "id")).toMatchObject({ side: "ask", price: "0.4200", reduce_only: true });
    expect(toCreateOrder({ ...base, side: "NO", action: "buy", limitPrice: 0.75 }, "id")).toMatchObject({ side: "ask", price: "0.2500", reduce_only: false });
    expect(toCreateOrder({ ...base, side: "NO", action: "sell", limitPrice: 0.75 }, "id")).toMatchObject({ side: "bid", price: "0.2500", reduce_only: true });
  });

  it("never loosens a limit when rounding to the cent", () => {
    // Buy YES ≤ 0.715 → bid 0.71, not 0.72.
    expect(toCreateOrder({ ...base, side: "YES", action: "buy", limitPrice: 0.715 }, "id").price).toBe("0.7100");
    // Buy NO ≤ 0.715 → ask on YES ≥ 0.285 → 0.29, i.e. NO ≤ 0.71.
    expect(toCreateOrder({ ...base, side: "NO", action: "buy", limitPrice: 0.715 }, "id").price).toBe("0.2900");
  });

  it("reads a fill back in the contract's own terms", () => {
    const yes = fromCreateOrderResponse({ fill_count: "10.00", average_fill_price: "0.4200", average_fee_paid: "0.0170" }, { ...base, side: "YES", action: "buy", limitPrice: 0.42 });
    expect(yes).toEqual({ count: 10, avgPrice: 0.42, feePerContract: 0.017 });
    const no = fromCreateOrderResponse({ fill_count: "4.00", average_fill_price: "0.2500" }, { ...base, side: "NO", action: "buy", limitPrice: 0.75 });
    expect(no.avgPrice).toBe(0.75);
    expect(no.feePerContract).toBeCloseTo(kalshiFee(4, 0.75) / 4, 4);
    expect(fromCreateOrderResponse({ fill_count: "0.00", remaining_count: "10.00" }, { ...base, side: "YES", action: "buy", limitPrice: 0.42 }).count).toBe(0);
  });

  it("maps exchange positions to our symbols (negative = NO)", () => {
    const m = exchangePositions({ market_positions: [{ ticker: "A", position_fp: "12.00" }, { ticker: "B", position_fp: "-5.00" }, { ticker: "C", position_fp: "0.00" }] });
    expect([...m]).toEqual([["A:YES", 12], ["B:NO", 5]]);
  });

  it("derives a stable, UUID-shaped client order id per action", () => {
    const a = clientOrderIdFor("nws_01M619V600FZGEPX5AFTVCJQ0D#1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(clientOrderIdFor("nws_01M619V600FZGEPX5AFTVCJQ0D#1")).toBe(a);
    expect(clientOrderIdFor("nws_01M619V600FZGEPX5AFTVCJQ0D#2")).not.toBe(a);
  });
});

describe("request signing", () => {
  const text = (ts: string) => Buffer.from(`${ts}GET/trade-api/v2/portfolio/balance`, "utf8");
  it("signs timestamp+METHOD+path without the query, Ed25519", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const sig = signKalshi(privateKey, "1700000000000", "get", "/trade-api/v2/portfolio/balance?limit=5");
    expect(crypto.verify(null, text("1700000000000"), publicKey, Buffer.from(sig, "base64"))).toBe(true);
  });
  it("signs with RSA-PSS SHA-256, salt = digest length", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sig = signKalshi(privateKey, "1700000000000", "GET", "/trade-api/v2/portfolio/balance");
    const ok = crypto.verify("sha256", text("1700000000000"), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sig, "base64"));
    expect(ok).toBe(true);
  });
});

describe("shadow record", () => {
  it("compares the paper fill with the real book walk, fee included", () => {
    const r = shadowOf(
      { symbol: "KXFEDDECISION-26DEC-H0:YES", action: "buy", notionalUsd: 100, paper: { qty: 344, fillPrice: 0.29, notionalUsd: 99.76 }, paperStatus: "filled" },
      parseOrderbook(FED),
    )!;
    expect(r.real.count).toBe(344);
    expect(r.gap_cents).toBeGreaterThan(0); // the fee makes reality worse than paper
    expect(r.fill_ratio).toBeGreaterThan(0.99);
  });
  it("ignores non-Kalshi symbols", () => {
    expect(shadowOf({ symbol: "some-polymarket-slug:YES", action: "buy", notionalUsd: 100, paperStatus: "filled" }, parseOrderbook(FED))).toBeNull();
  });
});
