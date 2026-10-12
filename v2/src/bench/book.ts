// SPDX-License-Identifier: MIT-0
import { config } from "../config.js";
import {
  applyFill,
  bookEquity,
  shortCollateralOk,
  shortExposure,
  type PositionState,
  clampReduceOnly,
} from "../positions.js";
import {
  fillPrice,
  liquidityCap,
  liquidationPrice,
  round8,
  SHORTABLE_KINDS,
} from "../exec.js";
import { bookUtilization, renderMandate, type WatchIdea } from "../mandate.js";
import type { Quote, TradeDecision } from "../types.js";

/**
 * An in-memory paper book for the replay bench: the same broker rules as
 * exec.ts executeDecision + ledger.recordFill, without DynamoDB, so a
 * simulated portfolio can carry across replayed events and a strategy is
 * scored on a book rather than on isolated decisions.
 *
 * Mirrors, in exec's order: quote staleness (against the BOOK's clock, not
 * wall time — the whole point of a replay), full-spread fill or 2 bps adverse
 * (fillPrice), the agent's own limit_price, positive notional, resolved
 * markets refused, fill notional capped to config.maxFillLiquidityFraction of
 * the visible book (liquidityCap), whole contracts for prediction markets,
 * cash never negative, shorts only for SHORTABLE_KINDS, total short exposure
 * at entry prices <= book equity (no leverage), signed positions via
 * applyFill, cash moved by qty * fillPrice and a position deleted at qty 0
 * (ledger.recordFill). Not mirrored: "unseeded" (this book is always seeded)
 * and "unresolvable" (the caller resolves — as-of — before calling apply).
 * One addition: a quote stamped materially AFTER the book clock is refused
 * (lookahead is the bench's cardinal sin; the tolerance covers tape rounding).
 */

export interface SimPosition extends PositionState {
  symbol: string;
  kind: string;
  /** Liquidation mark: bid for a long, ask for a short. Set on fill and by mark(). */
  last_seen_price?: number;
}

export interface SimFill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  fillPrice: number;
  notionalUsd: number;
  slippageBps: number;
  /** Book clock at the fill. */
  atMs: number;
  decisionId: string;
  liquidityCapped?: { requested: number; bookUsd: number };
  // Additive to the spec (ledger.Fill carries them too):
  kind: string;
  quotePrice: number;
  realizedPnl: number;
}

export type SimOutcome =
  | {
      status: "filled";
      fill: SimFill;
      /** Signed qty held before this fill (long > 0, short < 0): was this a reduction? */
      positionBefore: number;
    }
  | { status: "dropped"; reason: string; detail?: string };

/** A quote may lead the book clock by this much (tape sampling / timestamp rounding) before it is lookahead. */
export const FUTURE_QUOTE_TOLERANCE_MS = 60_000;

function dropped(reason: string, detail: string): SimOutcome {
  return { status: "dropped", reason, detail };
}

export class SimBook {
  private _cash: number;
  private _nowMs: number;
  private _realizedPnl = 0;
  private readonly _positions = new Map<string, SimPosition>();
  private readonly _fills: SimFill[] = [];

  constructor(opts: { cash: number; nowMs: number }) {
    if (!Number.isFinite(opts.cash) || opts.cash < 0) {
      throw new Error(`SimBook: cash must be a non-negative number, got ${opts.cash}`);
    }
    this._cash = opts.cash;
    this._nowMs = opts.nowMs;
  }

  get cash(): number {
    return this._cash;
  }
  /** Open positions (copies; mutate through apply/mark). */
  get positions(): SimPosition[] {
    return [...this._positions.values()].map((p) => ({ ...p }));
  }
  get fills(): SimFill[] {
    return [...this._fills];
  }
  /** Sum of realized P&L over every fill so far. */
  get realizedPnl(): number {
    return this._realizedPnl;
  }
  get nowMs(): number {
    return this._nowMs;
  }

  setClock(nowMs: number): void {
    this._nowMs = nowMs;
  }

  /**
   * Apply a buy/sell decision against a quote (the caller resolves it, as-of).
   * Returns the outcome; mutates the book on fill.
   */
  apply(
    decision: TradeDecision & { action: "buy" | "sell" },
    quote: Quote,
    decisionId: string,
    opts: { maxQuoteAgeSecs?: number } = {},
  ): SimOutcome {
    const side = decision.action;
    // Live quotes must be under config.maxQuoteAgeSecs. A historical bar is at
    // most its own span old by construction, so the runner widens the bound to
    // the span (granularity is not a closed venue).
    const maxQuoteAgeSecs = opts.maxQuoteAgeSecs ?? config.maxQuoteAgeSecs;

    if (quote.asOfMs > this._nowMs + FUTURE_QUOTE_TOLERANCE_MS) {
      return dropped(
        "dropped_future_quote",
        `${quote.symbol}: quote stamped ${Math.round((quote.asOfMs - this._nowMs) / 1000)}s after the book clock (lookahead)`,
      );
    }
    const ageSecs = Math.max(0, Math.round((this._nowMs - quote.asOfMs) / 1000));
    if (ageSecs > maxQuoteAgeSecs) {
      return dropped(
        "dropped_stale_quote",
        `${quote.symbol}: quote is ${ageSecs}s old at book time (max ${maxQuoteAgeSecs}s)`,
      );
    }

    const calc = fillPrice(quote, side);
    if (!calc) {
      return dropped(
        "dropped_empty_book",
        `${quote.symbol}: no resting ${side === "buy" ? "ask" : "bid"}`,
      );
    }
    // Agent-set limit (its own decision, not a risk gate): don't chase the price.
    if (decision.limit_price !== undefined) {
      const violated =
        side === "buy" ? calc.fillPrice > decision.limit_price : calc.fillPrice < decision.limit_price;
      if (violated) {
        return dropped("limit_not_met", `${quote.symbol}: fill ${calc.fillPrice} vs limit ${decision.limit_price}`);
      }
    }

    let notional = decision.notional_usd ?? 0;
    if (!(notional > 0)) {
      return dropped("bad_notional", `notional_usd=${notional}`);
    }
    if (quote.resolved) {
      return dropped(
        "market_resolved",
        `${quote.symbol}: market has resolved (payout ${quote.price}); settlement handles it`,
      );
    }

    // Liquidity realism: a fill can only take a fraction of the resting book.
    const cap = liquidityCap(quote.liquidityUsd);
    let liquidityCapped: SimFill["liquidityCapped"];
    if (cap !== null && notional > cap) {
      if (cap < 1) {
        return dropped(
          "dropped_illiquid",
          `${quote.symbol}: resting book $${quote.liquidityUsd} cannot absorb a fill`,
        );
      }
      liquidityCapped = { requested: notional, bookUsd: quote.liquidityUsd! };
      notional = cap;
    }

    const existing = this._positions.get(quote.symbol) ?? null;
    const oldQty = existing?.qty ?? 0;

    let qty = round8(notional / calc.fillPrice);
    if (quote.kind === "prediction") qty = Math.floor(qty); // whole contracts
    if (qty <= 0) {
      return dropped("zero_qty", `notional too small at ${calc.fillPrice}`);
    }
    // Working remainder of a capped exit: only ever shrink the position it was placed against (exec.ts).
    if (decision.reduce_only) {
      const r = clampReduceOnly(side, oldQty, qty, quote.symbol);
      if (!r.ok) return dropped(r.reason, r.detail);
      qty = r.qty;
      notional = round8(qty * calc.fillPrice);
    }

    const cashDelta = side === "buy" ? -(qty * calc.fillPrice) : qty * calc.fillPrice;

    if (side === "buy") {
      // exec checks the requested notional; the ledger's transaction then guards
      // cash >= qty * fillPrice. Both here, so cash can never go negative.
      if (this._cash < notional || this._cash + cashDelta < 0) {
        return dropped(
          "insufficient_cash",
          `cash ${this._cash.toFixed(2)} < notional ${notional}`,
        );
      }
    } else {
      // Selling more than is held opens (or adds to) a short.
      const opensShort = qty > Math.max(0, oldQty);
      if (opensShort) {
        if (!SHORTABLE_KINDS.has(quote.kind)) {
          return dropped(
            "not_shortable",
            quote.kind === "prediction"
              ? `${quote.symbol}: contracts are not sold short — buy the NO side (${quote.symbol.replace(/:YES$/, ":NO")}) instead`
              : `${quote.symbol}: ${quote.kind} venues are one-sided; no short expression`,
          );
        }
        const positions = [...this._positions.values()];
        const others = positions.filter((p) => p.symbol !== quote.symbol);
        const shortAfter =
          shortExposure(others) +
          Math.max(0, qty - Math.max(0, oldQty)) * calc.fillPrice +
          (oldQty < 0 ? Math.abs(oldQty) * (existing?.avg_cost ?? 0) : 0);
        const equity = bookEquity(this._cash, positions);
        if (!shortCollateralOk(shortAfter, equity)) {
          return dropped(
            "insufficient_collateral",
            `${quote.symbol}: short exposure after fill $${shortAfter.toFixed(0)} would exceed book equity $${equity.toFixed(0)} (no leverage)`,
          );
        }
      }
    }

    const effect = applyFill(
      existing ? { qty: existing.qty, avg_cost: existing.avg_cost } : null,
      side,
      qty,
      calc.fillPrice,
    );

    // Book it (ledger.recordFill semantics).
    this._cash += cashDelta;
    this._realizedPnl += effect.realizedPnl;
    if (effect.newQty === 0) {
      this._positions.delete(quote.symbol);
    } else {
      this._positions.set(quote.symbol, {
        symbol: quote.symbol,
        kind: quote.kind,
        qty: effect.newQty,
        avg_cost: effect.newAvgCost,
        // The book just saw this quote: mark at liquidation value now rather
        // than at cost until a watcher pass (a long bought at the ask is worth
        // the bid the moment it fills).
        last_seen_price: liquidationPrice(quote, effect.newQty),
      });
    }

    const fill: SimFill = {
      symbol: quote.symbol,
      kind: quote.kind,
      side,
      qty,
      quotePrice: quote.price,
      fillPrice: calc.fillPrice,
      slippageBps: calc.slippageBps,
      notionalUsd: round8(qty * calc.fillPrice),
      realizedPnl: effect.realizedPnl,
      atMs: this._nowMs,
      decisionId,
      ...(liquidityCapped ? { liquidityCapped } : {}),
    };
    this._fills.push(fill);
    return { status: "filled", fill, positionBefore: oldQty };
  }

  /** Update last_seen_price for held symbols from quotes (liquidation marks: bid for longs, ask for shorts). */
  mark(quotes: Record<string, Quote>): void {
    for (const p of this._positions.values()) {
      const q = quotes[p.symbol];
      if (q) p.last_seen_price = liquidationPrice(q, p.qty);
    }
  }

  /** cash + sum(qty * mark) at liquidation value; a position never marked counts at cost. */
  equity(): number {
    let signed = 0;
    for (const p of this._positions.values()) {
      signed += p.qty * (p.last_seen_price ?? p.avg_cost);
    }
    return this._cash + signed;
  }

  /**
   * Same JSON shape pipeline.ts buildBookContext uses, so bookUtilization() /
   * renderMandate() work unchanged.
   */
  snapshot(): {
    cash_usd: number;
    positions: Array<{
      symbol: string;
      kind: string;
      qty: number;
      avg_cost: number;
      last_seen_price: number | null;
    }>;
  } {
    return {
      cash_usd: this._cash,
      positions: [...this._positions.values()].map((p) => ({
        symbol: p.symbol,
        kind: p.kind,
        qty: p.qty,
        avg_cost: p.avg_cost,
        last_seen_price: p.last_seen_price ?? null,
      })),
    };
  }

  /**
   * Rendered context for the agent: snapshot JSON + the mandate block, exactly
   * as pipeline.ts assembles it (held symbols are dropped from the watchlist;
   * watchlist ages are measured against the book clock). Standing theses,
   * world model and pending orders are not rendered — the bench has none.
   */
  renderContext(watchlist: WatchIdea[] = []): string {
    const snap = this.snapshot();
    const held = new Set(snap.positions.map((p) => p.symbol));
    return [
      JSON.stringify(snap),
      renderMandate(
        bookUtilization(snap),
        watchlist.filter((w) => !held.has(w.symbol)),
        config.mandate,
        new Date(this._nowMs),
      ),
    ].join("\n");
  }
}
