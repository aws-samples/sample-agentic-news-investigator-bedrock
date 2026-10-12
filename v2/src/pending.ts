// SPDX-License-Identifier: MIT-0
import { PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";
import { executeDecision } from "./exec.js";
import { resolve } from "./quotes/resolver.js";
import { putAudit } from "./audit.js";
import type { InstrumentKind, TradeDecision } from "./types.js";

/**
 * Parked orders ("set up a trade at the open"): when a decision can't fill —
 * venue closed (stale quote) or the agent's limit not met — it parks here and
 * the watcher retries every few minutes until it fills or expires. This also
 * closes the silent-drop feedback gap: pending orders ride along in the book
 * context, so later investigations know an order is waiting. One pending order
 * per symbol; a newer decision on that symbol supersedes it.
 */

export interface PendingOrder {
  symbol: string;
  kind?: InstrumentKind;
  side: "buy" | "sell";
  notional_usd: number;
  limit_price?: number;
  confidence: number;
  news_id: string;
  /** Per-action id when the decision was one of several; used as the order id. */
  action_id?: string;
  created_at: string;
  expires_at: string;
  parked_reason: string;
  rationale: string;
  /** Working remainder of a liquidity-capped exit: only ever shrinks the position (exec clamps). */
  reduce_only?: boolean;
  /** The size the decision asked for, before any cap. */
  requested_usd?: number;
  /** Slices filled so far. */
  filled_usd?: number;
  /** The next slice may not run before this instant (book-replenishment pacing). */
  not_before?: string;
}

/** Drop reasons that mean "retry later" rather than "give up". */
export const PARKABLE_REASONS = new Set(["dropped_stale_quote", "limit_not_met"]);

/**
 * A working (reduce-only) remainder also waits through an empty or sub-$1 book:
 * the bids will come back, and dropping a decided exit is the failure this
 * mechanism exists to fix.
 */
export const RETRY_WHILE_REDUCING = new Set([...PARKABLE_REASONS, "dropped_illiquid", "dropped_empty_book"]);
/** Below this a remainder is dust, not an order. */
export const MIN_SLICE_USD = 1;

/** Does a fill on this side shrink the position held before it? */
export function isReduction(side: "buy" | "sell", positionBefore: number): boolean {
  return side === "sell" ? positionBefore > 0 : positionBefore < 0;
}

export function positionAfterFill(positionBefore: number, side: "buy" | "sell", qty: number): number {
  return Math.round((positionBefore + (side === "buy" ? qty : -qty)) * 1e8) / 1e8;
}

export function sliceDue(order: PendingOrder, nowMs = Date.now()): boolean {
  return !order.not_before || nowMs >= Date.parse(order.not_before);
}

/**
 * The working order left after a liquidity-capped slice of `order` filled
 * `filledUsd`, or null when nothing meaningful remains (dust, or the position it
 * was reducing is gone). Keeps the original expiry: a thin book does not buy the
 * agent's decision a longer life.
 */
export function remainderAfter(
  order: PendingOrder,
  filledUsd: number,
  positionAfter: number,
  nowMs = Date.now(),
): PendingOrder | null {
  const remaining = Math.round((order.notional_usd - filledUsd) * 100) / 100;
  if (remaining < MIN_SLICE_USD) return null;
  if (!isReduction(order.side, positionAfter)) return null;
  return {
    ...order,
    notional_usd: remaining,
    requested_usd: order.requested_usd ?? order.notional_usd,
    filled_usd: Math.round(((order.filled_usd ?? 0) + filledUsd) * 100) / 100,
    reduce_only: true,
    parked_reason: "liquidity_capped",
    not_before: new Date(nowMs + config.pendingSliceMinutes * 60_000).toISOString(),
  };
}

export function isExpired(order: PendingOrder, nowMs = Date.now()): boolean {
  return nowMs >= Date.parse(order.expires_at);
}

export async function savePending(order: PendingOrder): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: { pk: `PENDING#${order.symbol}`, sk: "-", ...order },
    }),
  );
}

export async function cancelPending(symbol: string): Promise<void> {
  await ddb
    .send(
      new DeleteCommand({
        TableName: config.table,
        Key: { pk: `PENDING#${symbol}`, sk: "-" },
      }),
    )
    .catch(() => {});
}

export async function listPending(): Promise<PendingOrder[]> {
  const out: PendingOrder[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: config.table,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": "PENDING#" },
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((r.Items as PendingOrder[] | undefined) ?? []));
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

function toDecision(o: PendingOrder): TradeDecision & { action: "buy" | "sell" } {
  return {
    action: o.side,
    symbol: o.symbol,
    kind: o.kind,
    notional_usd: o.notional_usd,
    limit_price: o.limit_price,
    reduce_only: o.reduce_only,
    confidence: o.confidence,
    rationale: o.rationale,
    evidence: [],
  };
}

/** Called from the watcher every few minutes. */
export async function retryPending(): Promise<void> {
  for (const order of await listPending()) {
    try {
      if (isExpired(order)) {
        await cancelPending(order.symbol);
        await putAudit(order.news_id, "v2-order-expired", { order });
        console.log(`[pending] EXPIRED ${order.side} ${order.symbol} $${order.notional_usd}`);
        continue;
      }
      // Pacing between slices of a working exit: the book gets time to replenish.
      if (!sliceDue(order)) continue;
      const outcome = await executeDecision(
        toDecision(order),
        order.action_id ?? order.news_id,
        resolve,
        order.news_id,
      );
      if (outcome.status === "filled") {
        const f = outcome.fill;
        // A capped slice of a working exit leaves the rest working; anything
        // else (full fill, or a plain parked order) is done.
        const rest =
          outcome.liquidityCapped && order.reduce_only
            ? remainderAfter(order, f.notionalUsd, positionAfterFill(outcome.positionBefore, f.side, f.qty))
            : null;
        if (rest) await savePending(rest);
        else await cancelPending(order.symbol);
        await putAudit(order.news_id, "v2-execution", {
          ...outcome,
          pending_fill: true,
          ...(order.reduce_only ? { slice: true, remaining_usd: rest?.notional_usd ?? 0 } : {}),
        });
        console.log(
          `[pending] ${rest ? "SLICE" : "FILLED (deferred)"} ${f.side} ${f.qty} ${f.symbol} @ ${f.fillPrice} ` +
            `(${f.slippageBps.toFixed(1)} bps slip, ${f.quoteSource})` +
            (rest ? `; $${rest.notional_usd} still working, next slice after ${rest.not_before}` : ""),
        );
      } else {
        const retryable = order.reduce_only
          ? RETRY_WHILE_REDUCING.has(outcome.reason)
          : PARKABLE_REASONS.has(outcome.reason);
        if (!retryable) {
          // terminal failure (no cash, position gone, unresolvable): give up loudly
          await cancelPending(order.symbol);
          await putAudit(order.news_id, "v2-order-cancelled", { order, outcome });
          console.log(`[pending] CANCELLED ${order.symbol}: ${outcome.reason} — ${outcome.detail}`);
        }
        // still parkable: leave it for the next pass
      }
    } catch (e) {
      console.error(`[pending] retry failed for ${order.symbol}:`, e);
    }
  }
}
