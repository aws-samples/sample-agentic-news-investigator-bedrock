// SPDX-License-Identifier: MIT-0
/**
 * Pure Kalshi arithmetic shared by the paper broker's fee (exec.ts), shadow mode (shadow.ts) and
 * the live broker (broker.ts). No I/O, so every rule here is unit-tested (test/live-kalshi.test.ts).
 *
 * Kalshi's V2 order API (POST /portfolio/events/orders, checked against docs.kalshi.com
 * 2026-10-30) has ONE book per market: `bid` buys YES, `ask` sells YES. Holding NO is a negative
 * YES position, so buying NO at q is an `ask` on YES at 1 − q, and selling NO is a `bid` at 1 − q.
 * Prices and counts are fixed-point strings. The public order book lists YES bids and NO bids
 * (`orderbook_fp.yes_dollars` / `no_dollars`, ascending); a YES ask is 1 − a NO bid.
 */

export type ContractSide = "YES" | "NO";

export interface KalshiSymbol {
  ticker: string;
  side: ContractSide;
}

/**
 * `KXFEDDECISION-26DEC-H0:NO` → { ticker, side }. Kalshi tickers are upper case, Polymarket slugs
 * lower case (the resolver's own rule). Not every series starts with KX: the Senate races are
 * `SENATEMI-26-D` (v6 traded three on 2026-11-03), so the prefix must not be required.
 */
export function parseKalshiSymbol(symbol: string): KalshiSymbol | null {
  const m = /^([A-Z0-9][A-Z0-9.\-]*[A-Z][A-Z0-9.\-]*):(YES|NO)$/.exec(symbol);
  return m ? { ticker: m[1], side: m[2] as ContractSide } : null;
}

/**
 * Kalshi's taker fee for one order: 0.07 × contracts × P × (1 − P), rounded UP to the cent.
 * P(1 − P) is symmetric, so the contract-side price works for YES and NO alike. Rounding is per
 * order, which is why tiny orders pay proportionally more.
 */
export function kalshiFee(count: number, price: number): number {
  if (!(count > 0) || !(price > 0 && price < 1)) return 0;
  return Math.ceil(0.07 * count * price * (1 - price) * 100 - 1e-9) / 100;
}

export interface Level {
  price: number;
  qty: number;
}

export interface Book {
  /** Resting bids to BUY each side, best (highest) first. */
  yesBids: Level[];
  noBids: Level[];
}

/** `GET /markets/{ticker}/orderbook` → Book. Tolerates a missing or empty side. */
export function parseOrderbook(json: any): Book {
  const side = (rows: unknown): Level[] =>
    (Array.isArray(rows) ? rows : [])
      .map((r: any) => ({ price: Number(r?.[0]), qty: Number(r?.[1]) }))
      .filter((l) => l.price > 0 && l.price < 1 && l.qty > 0)
      .sort((a, b) => b.price - a.price);
  const ob = json?.orderbook_fp ?? {};
  return { yesBids: side(ob.yes_dollars), noBids: side(ob.no_dollars) };
}

/** What a taker pays to BUY `side`: the other side's bids, flipped (YES ask = 1 − NO bid), cheapest first. */
export function asksFor(book: Book, side: ContractSide): Level[] {
  const other = side === "YES" ? book.noBids : book.yesBids;
  return other.map((l) => ({ price: round4(1 - l.price), qty: l.qty })).sort((a, b) => a.price - b.price);
}

/** What a taker receives SELLING `side`: that side's bids, best first. */
export function bidsFor(book: Book, side: ContractSide): Level[] {
  return [...(side === "YES" ? book.yesBids : book.noBids)];
}

export interface Walk {
  /** Whole contracts filled. */
  count: number;
  /** Volume-weighted price before the fee. */
  avgPrice: number;
  /** Fee for the whole order (one order, so rounded once). */
  fee: number;
  /** Price per contract including the fee: what a buy really costs / a sell really nets. */
  effectivePrice: number;
  levelsUsed: number;
  /** Notional at avgPrice. */
  usd: number;
}

/**
 * Walk a taker order through the book: buy up to `maxUsd` (or sell up to `maxCount`), never past
 * `limit`. Whole contracts only. Returns count 0 when nothing is fillable inside the limit.
 */
export function walkBook(
  levels: Level[],
  opts: { action: "buy" | "sell"; maxUsd?: number; maxCount?: number; limit?: number },
): Walk {
  let count = 0;
  let usd = 0;
  let used = 0;
  for (const l of levels) {
    if (opts.limit !== undefined && (opts.action === "buy" ? l.price > opts.limit + 1e-9 : l.price < opts.limit - 1e-9)) break;
    let take = Math.floor(l.qty);
    if (opts.maxCount !== undefined) take = Math.min(take, Math.floor(opts.maxCount) - count);
    if (opts.maxUsd !== undefined) take = Math.min(take, Math.floor((opts.maxUsd - usd) / l.price + 1e-9));
    if (take <= 0) break;
    count += take;
    usd += take * l.price;
    used++;
  }
  const avgPrice = count > 0 ? usd / count : 0;
  const fee = kalshiFee(count, avgPrice);
  const perContract = count > 0 ? fee / count : 0;
  return {
    count,
    avgPrice: round4(avgPrice),
    fee,
    effectivePrice: round4(opts.action === "buy" ? avgPrice + perContract : avgPrice - perContract),
    levelsUsed: used,
    usd: Math.round(usd * 100) / 100,
  };
}

/** One order as the live broker means it: contract side, direction, whole contracts, a price cap/floor. */
export interface OrderIntent {
  ticker: string;
  side: ContractSide;
  action: "buy" | "sell";
  count: number;
  /** Worst acceptable price in the contract's own terms (a NO price for a NO order). */
  limitPrice: number;
}

export interface CreateOrderV2Request {
  ticker: string;
  client_order_id: string;
  side: "bid" | "ask";
  count: string;
  price: string;
  time_in_force: "immediate_or_cancel";
  self_trade_prevention_type: "taker_at_cross";
  reduce_only: boolean;
  cancel_order_on_pause: true;
}

/**
 * Every live order is immediate-or-cancel at a limit: it takes what the book offers inside the
 * price and cancels the rest, so nothing rests unattended (the experiment's pending.ts slicing is
 * a paper concept). Exits are reduce_only, which Kalshi only accepts with IOC.
 */
export function toCreateOrder(intent: OrderIntent, clientOrderId: string): CreateOrderV2Request {
  const onYesBook = intent.side === "YES";
  const buyingYesBook = intent.action === "buy" ? onYesBook : !onYesBook;
  const bookPrice = onYesBook ? intent.limitPrice : 1 - intent.limitPrice;
  return {
    ticker: intent.ticker,
    client_order_id: clientOrderId,
    side: buyingYesBook ? "bid" : "ask",
    count: Math.floor(intent.count).toFixed(2),
    // Rounding to the cent must never loosen the limit: a bid rounds down, an ask up.
    price: toCent(bookPrice, buyingYesBook ? "down" : "up").toFixed(4),
    time_in_force: "immediate_or_cancel",
    self_trade_prevention_type: "taker_at_cross",
    reduce_only: intent.action === "sell",
    cancel_order_on_pause: true,
  };
}

/**
 * The exchange's answer, back in the contract's own terms. `average_fill_price` is a YES-book
 * price, so a NO order's price is 1 − it. ASSUMPTION to confirm on the demo exchange before any
 * prod order: the docs do not say which book the average is quoted on.
 */
export function fromCreateOrderResponse(
  resp: any,
  intent: OrderIntent,
): { count: number; avgPrice: number; feePerContract: number } {
  const count = Math.floor(Number(resp?.fill_count ?? 0) + 1e-9);
  if (!(count > 0)) return { count: 0, avgPrice: 0, feePerContract: 0 };
  const bookAvg = Number(resp?.average_fill_price);
  const avgPrice = intent.side === "YES" ? bookAvg : 1 - bookAvg;
  const feePerContract = Number(resp?.average_fee_paid ?? 0) || kalshiFee(count, avgPrice) / count;
  return { count, avgPrice: round4(avgPrice), feePerContract: round4(feePerContract) };
}

/** Exchange positions → our symbols: position_fp > 0 is YES contracts, < 0 is NO. */
export function exchangePositions(json: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of json?.market_positions ?? []) {
    const q = Number(p?.position_fp ?? 0);
    if (!q) continue;
    out.set(`${p.ticker}:${q > 0 ? "YES" : "NO"}`, Math.abs(q));
  }
  return out;
}

/**
 * Deterministic client_order_id from our action id, so a retried submit of the same decision is
 * rejected by Kalshi as a duplicate (409) instead of trading twice. UUID-shaped, from FNV-1a.
 */
export function clientOrderIdFor(actionId: string): string {
  const parts: string[] = [];
  for (let seed = 0; seed < 4; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (const c of actionId) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    parts.push(h.toString(16).padStart(8, "0"));
  }
  const hex = parts.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function toCent(p: number, dir: "down" | "up"): number {
  const c = dir === "down" ? Math.floor(p * 100 + 1e-9) : Math.ceil(p * 100 - 1e-9);
  return Math.min(99, Math.max(1, c)) / 100;
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
