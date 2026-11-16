// SPDX-License-Identifier: MIT-0
import type { TradeDecision } from "../types.js";
import type { ExecOutcome } from "../exec.js";
import type * as ledger from "../ledger.js";
import { applyFill } from "../positions.js";
import {
  asksFor,
  bidsFor,
  clientOrderIdFor,
  exchangePositions,
  fromCreateOrderResponse,
  parseKalshiSymbol,
  parseOrderbook,
  toCreateOrder,
  type OrderIntent,
} from "./kalshi-core.js";
import { KalshiError } from "./kalshi-client.js";
import { sizeLiveOrder, type LiveLimits } from "./limits.js";

/**
 * The live broker: what executeDecision is for paper, for real money on Kalshi (V2_LIVE=demo|prod,
 * route.ts). Same input (one buy/sell action) and the same ExecOutcome, so the pipeline, theses,
 * audit and scoring treat a live fill exactly like a paper one.
 *
 * Order of checks, each one able to stop the order:
 *  1. kill switch (fails CLOSED: an unreadable switch halts trading),
 *  2. Kalshi contracts only,
 *  3. a book on the side we need,
 *  4. hard limits from the EXCHANGE's balance and positions (limits.ts), never the ledger's,
 *  5. one immediate-or-cancel limit order with a client_order_id derived from the action id, so a
 *     retry cannot trade twice.
 * Then the real fill (exchange price plus fee) is mirrored into the arm's ledger so the agent's
 * book context, the dashboard and the letter see what actually happened; reconcile() audits drift.
 */

export interface LiveDeps {
  client: {
    orderbook(ticker: string): Promise<any>;
    balance(): Promise<any>;
    positions(): Promise<any>;
    createOrder(order: unknown): Promise<any>;
  };
  /** null when trading may proceed; otherwise the reason it is halted. */
  halted(): Promise<string | null>;
  /** Equity at the day's first live action, recording `equity` if none yet. */
  dayStartEquity(equityUsd: number): Promise<number | null>;
  ledgerPosition(symbol: string): Promise<{ qty: number; avg_cost: number } | null>;
  recordFill(fill: ledger.Fill, position: { newQty: number; newAvgCost: number; expectedQty: number | null }): Promise<void>;
  limits: LiveLimits;
  /** How far past the top of book an order without its own limit may reach, in dollars per contract. */
  slippageTolerance: number;
  now?: () => Date;
}

const drop = (reason: string, detail: string): ExecOutcome => ({ status: "dropped", reason, detail });

export async function executeLive(
  decision: TradeDecision & { action: "buy" | "sell" },
  decisionId: string,
  newsId: string,
  deps: LiveDeps,
): Promise<ExecOutcome> {
  const halt = await deps.halted().catch((e) => `kill switch unreadable: ${String(e).slice(0, 120)}`);
  if (halt) return drop("live_halted", halt);

  const symbol = decision.symbol ?? "";
  const k = parseKalshiSymbol(symbol);
  if (!k) return drop("live_kalshi_only", `${symbol}: the live arm trades Kalshi contracts only`);

  const book = parseOrderbook(await deps.client.orderbook(k.ticker));
  const levels = decision.action === "buy" ? asksFor(book, k.side) : bidsFor(book, k.side);
  const top = levels[0]?.price;
  if (top === undefined) return drop("dropped_empty_book", `${symbol}: no resting ${decision.action === "buy" ? "ask" : "bid"}`);

  // The agent's own limit if it set one; otherwise the top of book plus a small tolerance.
  const limit =
    decision.limit_price ??
    Math.round((decision.action === "buy" ? top + deps.slippageTolerance : top - deps.slippageTolerance) * 100) / 100;
  if (decision.action === "buy" ? top > limit + 1e-9 : top < limit - 1e-9) {
    return drop("limit_not_met", `${symbol}: top of book ${top} vs limit ${limit}`);
  }

  // State from the exchange, not the ledger: the exchange is what can actually lose money.
  const [bal, pos] = await Promise.all([deps.client.balance(), deps.client.positions()]);
  const cashUsd = Number(bal?.balance ?? 0) / 100;
  const held = exchangePositions(pos);
  const costBySymbol = new Map<string, number>();
  for (const p of pos?.market_positions ?? []) {
    const q = Number(p?.position_fp ?? 0);
    if (q) costBySymbol.set(`${p.ticker}:${q > 0 ? "YES" : "NO"}`, Math.abs(Number(p.market_exposure_dollars ?? 0)));
  }
  // Kalshi nets YES and NO on one book: buying YES while NO is held SELLS the NO instead, which the
  // ledger (one symbol per side) would not see. Exit the other side first, as its own decision.
  const opposite = `${k.ticker}:${k.side === "YES" ? "NO" : "YES"}`;
  if (decision.action === "buy" && (held.get(opposite) ?? 0) > 0) {
    return drop("live_opposite_side_held", `${symbol}: ${held.get(opposite)} ${opposite} held on the same market; sell those first`);
  }
  // Equity at cost (cash + cost basis): realized losses and fees move it, open marks do not. A
  // backstop for the daily stop, deliberately simple; marks need a book per position.
  const equityUsd = cashUsd + [...costBySymbol.values()].reduce((s, v) => s + v, 0);
  const dayStart = await deps.dayStartEquity(equityUsd).catch(() => null);
  const sizing = sizeLiveOrder(
    { symbol, action: decision.action, desiredUsd: decision.notional_usd ?? 0, price: limit },
    { cashUsd, equityUsd, dayStartEquityUsd: dayStart, positionCostUsd: costBySymbol, heldCount: held.get(symbol) ?? 0 },
    deps.limits,
  );
  if (!sizing.ok) return drop("live_limit", sizing.reason);

  const intent: OrderIntent = { ticker: k.ticker, side: k.side, action: decision.action, count: sizing.count, limitPrice: limit };
  let resp: any;
  try {
    resp = await deps.client.createOrder(toCreateOrder(intent, clientOrderIdFor(decisionId)));
  } catch (e) {
    if (e instanceof KalshiError && e.status === 409) return drop("live_duplicate", `${symbol}: order for ${decisionId} already submitted`);
    return drop("live_order_error", String(e).slice(0, 300));
  }
  const got = fromCreateOrderResponse(resp, intent);
  if (got.count === 0) return drop("live_no_fill", `${symbol}: IOC at ${limit} filled nothing (top was ${top})`);

  // Mirror the real fill, fee folded into the price the way exec.ts folds it for paper.
  const effective = decision.action === "buy" ? got.avgPrice + got.feePerContract : got.avgPrice - got.feePerContract;
  const existing = await deps.ledgerPosition(symbol);
  const effect = applyFill(existing ? { qty: existing.qty, avg_cost: existing.avg_cost } : null, decision.action, got.count, effective);
  const fill: ledger.Fill = {
    decisionId,
    newsId,
    symbol,
    kind: "prediction",
    side: decision.action,
    qty: got.count,
    quotePrice: top,
    fillPrice: Math.round(effective * 10_000) / 10_000,
    slippageBps: Math.round(((effective - top) / top) * 1e4 * (decision.action === "buy" ? 1 : -1) * 10) / 10,
    notionalUsd: Math.round(got.count * effective * 100) / 100,
    quoteSource: `kalshi-live-${resp?.order_id ?? "?"}`,
    realizedPnl: effect.realizedPnl,
    filledAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.recordFill(fill, { newQty: effect.newQty, newAvgCost: effect.newAvgCost, expectedQty: existing?.qty ?? null });
  const requested = decision.notional_usd ?? 0;
  return {
    status: "filled",
    fill,
    // A partial IOC is reported like a paper liquidity cap; the pipeline may park the rest of an exit.
    liquidityCapped: fill.notionalUsd < requested * 0.98 ? { requested, bookUsd: fill.notionalUsd } : undefined,
    positionBefore: existing?.qty ?? 0,
  };
}

/** Ledger vs exchange, for the reconcile audit. Pure. Quantities are contracts (ledger qty > 0 for held contracts). */
export function reconcile(
  ledgerPositions: { symbol: string; qty: number }[],
  exchange: Map<string, number>,
): { symbol: string; ledger: number; exchange: number }[] {
  const out: { symbol: string; ledger: number; exchange: number }[] = [];
  const seen = new Set<string>();
  for (const p of ledgerPositions) {
    if (!parseKalshiSymbol(p.symbol)) continue;
    seen.add(p.symbol);
    const x = exchange.get(p.symbol) ?? 0;
    if (Math.abs(x - p.qty) > 1e-6) out.push({ symbol: p.symbol, ledger: p.qty, exchange: x });
  }
  for (const [symbol, x] of exchange) if (!seen.has(symbol)) out.push({ symbol, ledger: 0, exchange: x });
  return out;
}
