// SPDX-License-Identifier: MIT-0
/**
 * Hard limits for real money. The experiment arms deliberately have NO risk gate (CLAUDE.md: the
 * experiment measures unassisted judgment); a live arm trading the operator's money is a different
 * thing and gets one. Pure: sizing and refusals are decided here and unit-tested
 * (test/live-limits.test.ts); broker.ts only supplies state and executes.
 *
 * Exits are never blocked: a sell is capped only by what is held. Every limit below binds buys.
 */

export interface LiveLimits {
  /** Largest single order, USD. */
  maxOrderUsd: number;
  /** Largest cost basis in one contract after the order, USD. */
  maxPositionUsd: number;
  /** Largest total cost basis across all positions, USD. */
  maxDeployedUsd: number;
  /** No new buys once equity is this far below the day's starting equity, USD. */
  dailyLossStopUsd: number;
  /**
   * Buy only between these prices. Near-certain contracts risk ~$1 for cents (a paper desk held one
   * at 0.98 into a central-bank decision and lost nearly the whole stake); near-zero ones are lottery tickets.
   */
  minPrice: number;
  maxPrice: number;
}

/** Defaults sized for a first $500 account; every one is overridable from env (config.ts). */
export const DEFAULT_LIVE_LIMITS: LiveLimits = {
  maxOrderUsd: 50,
  maxPositionUsd: 100,
  maxDeployedUsd: 400,
  dailyLossStopUsd: 50,
  minPrice: 0.05,
  maxPrice: 0.95,
};

export interface LiveState {
  cashUsd: number;
  equityUsd: number;
  /** Equity at the day's first live action (LIVE/DAY#<date>); null before it is recorded. */
  dayStartEquityUsd: number | null;
  /** Cost basis per symbol, USD. */
  positionCostUsd: Map<string, number>;
  /** Contracts held in the order's symbol (from the exchange, not the ledger). */
  heldCount: number;
}

export interface LiveOrderRequest {
  symbol: string;
  action: "buy" | "sell";
  /** What the decision asked for, USD. */
  desiredUsd: number;
  /** The price the order will be limited at (contract terms). */
  price: number;
}

export type LiveSizing =
  | { ok: true; count: number; usd: number; capped: string[] }
  | { ok: false; reason: string };

export function sizeLiveOrder(req: LiveOrderRequest, state: LiveState, limits: LiveLimits): LiveSizing {
  if (!(req.price > 0 && req.price < 1)) return { ok: false, reason: `price ${req.price} is not a contract price` };
  if (req.action === "sell") {
    if (state.heldCount <= 0) return { ok: false, reason: "nothing held to sell (live contracts are never sold short)" };
    // An exit asking for ~all of the position sells all of it, so no dust is stranded.
    const wanted = Math.floor(req.desiredUsd / req.price + 1e-9);
    const count = wanted >= state.heldCount * 0.95 ? state.heldCount : Math.max(1, Math.min(wanted, state.heldCount));
    return { ok: true, count, usd: round2(count * req.price), capped: [] };
  }
  if (req.price < limits.minPrice || req.price > limits.maxPrice) {
    return { ok: false, reason: `buy price ${req.price} outside the live band ${limits.minPrice}-${limits.maxPrice}` };
  }
  if (state.dayStartEquityUsd !== null && state.equityUsd < state.dayStartEquityUsd - limits.dailyLossStopUsd) {
    return {
      ok: false,
      reason: `daily loss stop: equity $${state.equityUsd.toFixed(2)} vs $${state.dayStartEquityUsd.toFixed(2)} at the day's start (stop $${limits.dailyLossStopUsd})`,
    };
  }
  const deployed = [...state.positionCostUsd.values()].reduce((s, v) => s + v, 0);
  const held = state.positionCostUsd.get(req.symbol) ?? 0;
  const caps: [string, number][] = [
    ["requested", req.desiredUsd],
    ["max order", limits.maxOrderUsd],
    ["max position", limits.maxPositionUsd - held],
    ["max deployed", limits.maxDeployedUsd - deployed],
    // Keep room for the fee (at most 1.75c per contract, plus rounding).
    ["cash", state.cashUsd * 0.97],
  ];
  const usdCap = Math.min(...caps.map(([, v]) => v));
  const count = Math.floor(usdCap / req.price + 1e-9);
  if (count < 1) {
    const binding = caps.find(([, v]) => v === usdCap)?.[0] ?? "limits";
    return { ok: false, reason: `no room: ${binding} leaves $${Math.max(0, usdCap).toFixed(2)}` };
  }
  const capped = caps.slice(1).filter(([, v]) => v < req.desiredUsd).map(([k, v]) => `${k} $${Math.max(0, v).toFixed(2)}`);
  return { ok: true, count, usd: round2(count * req.price), capped };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
