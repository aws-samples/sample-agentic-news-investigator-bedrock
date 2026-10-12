// SPDX-License-Identifier: MIT-0
import type { Quote, Resolution, TradeDecision } from "./types.js";
import { config } from "./config.js";
import * as ledger from "./ledger.js";
import { applyFill, bookEquity, shortExposure, shortCollateralOk, clampReduceOnly } from "./positions.js";

const MIN_SLIPPAGE = 0.0002; // 2 bps adverse when there's no book

export type ExecOutcome =
  | {
      status: "filled";
      fill: ledger.Fill;
      /** Present when the book couldn't absorb the requested size. */
      liquidityCapped?: { requested: number; bookUsd: number };
      /** Signed qty held before this fill (long > 0, short < 0): was this a reduction? */
      positionBefore: number;
    }
  | { status: "dropped"; reason: string; detail: string };

export interface FillCalc {
  fillPrice: number;
  slippageBps: number;
}

/**
 * Full-spread fills everywhere a book exists (thin venues — prediction,
 * parallel FX — and Kraken majors alike): buy at ask, sell at bid. Without a
 * book, 2 bps adverse of the reference price.
 */
export function fillPrice(quote: Quote, side: "buy" | "sell"): FillCalc | null {
  const hasBook =
    quote.bid !== undefined && quote.ask !== undefined && quote.bid > 0 && quote.ask > 0;
  let price: number;
  if (hasBook) {
    price = side === "buy" ? quote.ask! : quote.bid!;
  } else if (quote.bid !== undefined || quote.ask !== undefined) {
    // One-sided book: refuse rather than invent the missing side.
    const side_ = side === "buy" ? quote.ask : quote.bid;
    if (side_ === undefined || side_ <= 0) return null;
    price = side_;
  } else {
    price = quote.price * (side === "buy" ? 1 + MIN_SLIPPAGE : 1 - MIN_SLIPPAGE);
  }
  const slippageBps = ((price - quote.price) / quote.price) * 1e4 * (side === "buy" ? 1 : -1);
  return { fillPrice: price, slippageBps };
}

export function round8(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

/** Max notional a fill may take from a book of the given depth; null = unknown depth. */
export function liquidityCap(liquidityUsd: number | undefined): number | null {
  if (liquidityUsd === undefined || !Number.isFinite(liquidityUsd)) return null;
  return Math.max(0, liquidityUsd) * config.maxFillLiquidityFraction;
}

/**
 * What a position could actually be closed at: the bid for a long, the ask for
 * a short (pass the signed qty). Mid-price marks on thin books are fiction
 * (observed: bid 0.15 / ask 0.97).
 */
export function liquidationPrice(
  q: { price: number; bid?: number; ask?: number; resolved?: boolean },
  qty = 1,
): number {
  if (q.resolved) return q.price;
  if (qty < 0) return q.ask !== undefined && q.ask > 0 ? q.ask : q.price;
  return q.bid !== undefined && q.bid > 0 ? q.bid : q.price;
}

/** Kinds that can be sold short. Prediction contracts have a NO side instead; parallel USDT rates are one-sided venues. */
export const SHORTABLE_KINDS = new Set(["equity", "crypto", "fx"]);

/**
 * Execute an approved-by-nobody decision (v2 has no risk gate by design):
 * re-quote deterministically, refuse stale quotes, fill, and book atomically.
 * `qty = notional / price` makes position return equal the % change of the
 * rate/price — a percentage-correct paper proxy for any quote currency.
 * Positions are signed: a sell beyond what is held opens a short (equities,
 * ETFs, futures, crypto, FX), a buy against a short covers it. The only
 * constraints are a paper broker's: cash cannot go negative and total short
 * exposure cannot exceed book equity (no leverage). Bookkeeping, not judgment.
 */
export async function executeDecision(
  decision: TradeDecision & { action: "buy" | "sell" },
  decisionId: string,
  resolveFn: (symbol: string, kind?: any) => Promise<Resolution>,
  newsId: string = decisionId,
): Promise<ExecOutcome> {
  const res = await resolveFn(decision.symbol!, decision.kind ?? "auto");
  if (!res.ok) {
    return { status: "dropped", reason: "unresolvable", detail: res.reason };
  }
  const { quote, meta } = res;
  if (meta.ageSecs > config.maxQuoteAgeSecs) {
    return {
      status: "dropped",
      reason: "dropped_stale_quote",
      detail: `${quote.symbol}: quote is ${meta.ageSecs}s old (max ${config.maxQuoteAgeSecs}s)`,
    };
  }
  const calc = fillPrice(quote, decision.action);
  if (!calc) {
    return {
      status: "dropped",
      reason: "dropped_empty_book",
      detail: `${quote.symbol}: no resting ${decision.action === "buy" ? "ask" : "bid"}`,
    };
  }
  // Agent-set limit (its own decision, not a risk gate): don't chase the price.
  if (decision.limit_price !== undefined) {
    const violated =
      decision.action === "buy"
        ? calc.fillPrice > decision.limit_price
        : calc.fillPrice < decision.limit_price;
    if (violated) {
      return {
        status: "dropped",
        reason: "limit_not_met",
        detail: `${quote.symbol}: fill ${calc.fillPrice} vs limit ${decision.limit_price}`,
      };
    }
  }

  let notional = decision.notional_usd ?? 0;
  if (!(notional > 0)) {
    return { status: "dropped", reason: "bad_notional", detail: `notional_usd=${notional}` };
  }
  if (quote.resolved) {
    return {
      status: "dropped",
      reason: "market_resolved",
      detail: `${quote.symbol}: market has resolved (payout ${quote.price}); settlement handles it`,
    };
  }

  // Liquidity realism: a fill can only take a fraction of the resting book.
  // (Market physics, not a risk gate — a $16 book cannot absorb $2,000.)
  const cap = liquidityCap(quote.liquidityUsd);
  let liquidityCapped: { requested: number; bookUsd: number } | undefined;
  if (cap !== null && notional > cap) {
    if (cap < 1) {
      return {
        status: "dropped",
        reason: "dropped_illiquid",
        detail: `${quote.symbol}: resting book $${quote.liquidityUsd} cannot absorb a fill`,
      };
    }
    liquidityCapped = { requested: notional, bookUsd: quote.liquidityUsd! };
    notional = cap;
  }

  const portfolio = await ledger.getPortfolio();
  if (!portfolio) {
    return {
      status: "dropped",
      reason: "unseeded",
      detail: "no PORTFOLIO/SNAPSHOT — run npm run seed -- --arm <key> --apply",
    };
  }
  const existing = await ledger.getPosition(quote.symbol);
  const oldQty = existing?.qty ?? 0;

  let qty = round8(notional / calc.fillPrice);
  if (quote.kind === "prediction") qty = Math.floor(qty); // whole contracts
  if (qty <= 0) {
    return { status: "dropped", reason: "zero_qty", detail: `notional too small at ${calc.fillPrice}` };
  }
  // Working remainder of a capped exit: only ever shrink the position it was placed against.
  if (decision.reduce_only) {
    const r = clampReduceOnly(decision.action, oldQty, qty, quote.symbol);
    if (!r.ok) return { status: "dropped", reason: r.reason, detail: r.detail };
    qty = r.qty;
    notional = round8(qty * calc.fillPrice);
  }

  if (decision.action === "buy") {
    if (portfolio.cash < notional) {
      return {
        status: "dropped",
        reason: "insufficient_cash",
        detail: `cash ${portfolio.cash.toFixed(2)} < notional ${notional}`,
      };
    }
  } else {
    // Selling more than is held opens (or adds to) a short.
    const opensShort = qty > Math.max(0, oldQty);
    if (opensShort) {
      if (!SHORTABLE_KINDS.has(quote.kind)) {
        return {
          status: "dropped",
          reason: "not_shortable",
          detail:
            quote.kind === "prediction"
              ? `${quote.symbol}: contracts are not sold short — buy the NO side (${quote.symbol.replace(/:YES$/, ":NO")}) instead`
              : `${quote.symbol}: ${quote.kind} venues are one-sided; no short expression`,
        };
      }
      const positions = await ledger.listPositions();
      const others = positions.filter((p) => p.symbol !== quote.symbol);
      const shortAfter = shortExposure(others) + Math.max(0, qty - Math.max(0, oldQty)) * calc.fillPrice
        + (oldQty < 0 ? Math.abs(oldQty) * (existing?.avg_cost ?? 0) : 0);
      const equity = bookEquity(portfolio.cash, positions);
      if (!shortCollateralOk(shortAfter, equity)) {
        return {
          status: "dropped",
          reason: "insufficient_collateral",
          detail: `${quote.symbol}: short exposure after fill $${shortAfter.toFixed(0)} would exceed book equity $${equity.toFixed(0)} (no leverage)`,
        };
      }
    }
  }

  const effect = applyFill(existing ? { qty: existing.qty, avg_cost: existing.avg_cost } : null, decision.action, qty, calc.fillPrice);
  const realizedPnl = effect.realizedPnl;
  const newQty = effect.newQty;
  const newAvgCost = effect.newAvgCost;

  const fill: ledger.Fill = {
    decisionId, // per-action id; doubles as the ORDER# idempotency key
    newsId,
    symbol: quote.symbol,
    kind: quote.kind,
    side: decision.action,
    qty,
    quotePrice: quote.price,
    fillPrice: calc.fillPrice,
    slippageBps: calc.slippageBps,
    notionalUsd: round8(qty * calc.fillPrice),
    quoteSource: quote.source,
    realizedPnl,
    filledAt: new Date().toISOString(),
  };

  await ledger.recordFill(fill, {
    newQty,
    newAvgCost,
    expectedQty: existing?.qty ?? null,
  });
  return { status: "filled", fill, liquidityCapped, positionBefore: oldQty };
}
