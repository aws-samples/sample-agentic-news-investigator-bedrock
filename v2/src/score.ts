// SPDX-License-Identifier: MIT-0
import { PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";
import type { InstrumentKind, Resolution } from "./types.js";

/**
 * The reward signal (LongVideoAgent's core finding, transplanted): every
 * decision is scored against what the price actually did. Scoring is
 * PROSPECTIVE — no historical-data APIs — the scorer simply re-resolves the
 * instrument once each horizon has elapsed. Holds with a watch_symbol are
 * scored as counterfactual buys (a hold "wins" when the counterfactual return
 * is small or negative; reported separately, never sign-flipped).
 * Items live under pk=SCOREQ: sk "P#<decidedAt>#<newsId>" while pending,
 * rewritten to "D#..." when every horizon is resolved (number or null).
 */

export const HORIZONS = {
  "1h": 3_600_000,
  "1d": 86_400_000,
  "7d": 7 * 86_400_000,
} as const;
export type HorizonKey = keyof typeof HORIZONS;
const RET_ATTR: Record<HorizonKey, "ret_1h" | "ret_1d" | "ret_7d"> = {
  "1h": "ret_1h",
  "1d": "ret_1d",
  "7d": "ret_7d",
};
/** Max acceptable quote age when scoring a horizon. */
const MAX_SCORE_QUOTE_AGE_SECS = 30 * 60;

export interface ScoreItem {
  pk: "SCOREQ";
  sk: string;
  news_id: string;
  symbol: string;
  kind: InstrumentKind | string;
  action: "buy" | "sell" | "hold";
  confidence: number;
  decided_at: string;
  dry_run: boolean;
  degraded: boolean;
  price0: number | null;
  price0_at?: string;
  ret_1h?: number | null;
  ret_1d?: number | null;
  ret_7d?: number | null;
}

/**
 * Realistic round-trip prices: a buy (or counterfactual buy) enters at the
 * ask and is valued at the bid; a sell enters at the bid and is valued at the
 * ask. On tight books this ≈ mid; on thin books it exposes the spread you'd
 * actually pay (observed: bid 0.15 / ask 0.97 where mid said 0.56).
 */
export function entryPrice(
  q: { price: number; bid?: number; ask?: number },
  action: "buy" | "sell" | "hold",
): number {
  if (action === "sell") return q.bid !== undefined && q.bid > 0 ? q.bid : q.price;
  return q.ask !== undefined && q.ask > 0 ? q.ask : q.price;
}
export function exitPrice(
  q: { price: number; bid?: number; ask?: number; resolved?: boolean },
  action: "buy" | "sell" | "hold",
): number {
  if (q.resolved) return q.price;
  if (action === "sell") return q.ask !== undefined && q.ask > 0 ? q.ask : q.price;
  return q.bid !== undefined && q.bid > 0 ? q.bid : q.price;
}

/** Signed so that positive = the decision's direction was right. Holds = counterfactual buy. */
export function signedReturn(
  action: "buy" | "sell" | "hold",
  price0: number,
  price1: number,
): number {
  const raw = price1 / price0 - 1;
  return action === "sell" ? -raw : raw;
}

export function dueHorizons(item: ScoreItem, nowMs: number): HorizonKey[] {
  const decidedMs = Date.parse(item.decided_at);
  return (Object.keys(HORIZONS) as HorizonKey[]).filter(
    (h) => item[RET_ATTR[h]] === undefined && nowMs - decidedMs >= HORIZONS[h],
  );
}

/** A horizon expires (scored as null) when 2x its width has passed unscored. */
export function expiredHorizons(item: ScoreItem, nowMs: number): HorizonKey[] {
  const decidedMs = Date.parse(item.decided_at);
  return (Object.keys(HORIZONS) as HorizonKey[]).filter(
    (h) => item[RET_ATTR[h]] === undefined && nowMs - decidedMs > 2 * HORIZONS[h],
  );
}

export function isComplete(item: ScoreItem): boolean {
  return (Object.keys(HORIZONS) as HorizonKey[]).every(
    (h) => item[RET_ATTR[h]] !== undefined,
  );
}

export async function enqueueScore(
  entry: Omit<ScoreItem, "pk" | "sk">,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        pk: "SCOREQ",
        sk: `P#${entry.decided_at}#${entry.news_id}`,
        ...entry,
      },
    }),
  );
}

export async function listScoreItems(prefix: "P#" | "D#", table = config.table): Promise<ScoreItem[]> {
  const out: ScoreItem[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":p": "SCOREQ", ":s": prefix },
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((r.Items as ScoreItem[] | undefined) ?? []));
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

async function persist(item: ScoreItem): Promise<void> {
  if (isComplete(item)) {
    const done = { ...item, sk: `D#${item.sk.slice(2)}` };
    await ddb.send(new PutCommand({ TableName: config.table, Item: done }));
    await ddb.send(
      new DeleteCommand({
        TableName: config.table,
        Key: { pk: "SCOREQ", sk: item.sk },
      }),
    );
  } else {
    await ddb.send(new PutCommand({ TableName: config.table, Item: item }));
  }
}

/** One scoring sweep; called from the worker loop every ~15 min. Single-writer. */
export async function scorePass(
  resolveFn: (symbol: string, kind?: any) => Promise<Resolution>,
  nowMs = Date.now(),
): Promise<{ scored: number; expired: number; completed: number }> {
  const stats = { scored: 0, expired: 0, completed: 0 };
  const pending = await listScoreItems("P#");
  for (const item of pending) {
    let dirty = false;

    // Fill a missing baseline price; give up (all-null) if we can't within 1h.
    if (item.price0 === null || item.price0 === undefined) {
      const res = await resolveFn(item.symbol, item.kind);
      if (res.ok && res.meta.ageSecs <= MAX_SCORE_QUOTE_AGE_SECS) {
        item.price0 = entryPrice(res.quote, item.action);
        item.price0_at = new Date(nowMs).toISOString();
        dirty = true;
      } else if (nowMs - Date.parse(item.decided_at) > HORIZONS["1h"]) {
        for (const h of Object.keys(HORIZONS) as HorizonKey[]) item[RET_ATTR[h]] = null;
        stats.expired++;
        await persist(item);
        stats.completed++;
        continue;
      } else {
        continue; // retry next pass
      }
    }

    for (const h of expiredHorizons(item, nowMs)) {
      item[RET_ATTR[h]] = null;
      stats.expired++;
      dirty = true;
    }

    const due = dueHorizons(item, nowMs);
    if (due.length > 0) {
      const res = await resolveFn(item.symbol, item.kind);
      if (res.ok && res.meta.ageSecs <= MAX_SCORE_QUOTE_AGE_SECS) {
        for (const h of due) {
          item[RET_ATTR[h]] = signedReturn(
            item.action,
            item.price0!,
            exitPrice(res.quote, item.action),
          );
          stats.scored++;
          dirty = true;
        }
      }
      // resolve failed / stale: leave for next pass (expiry rule bounds retries)
    }

    if (dirty) {
      const wasComplete = isComplete(item);
      await persist(item);
      if (wasComplete) stats.completed++;
    }
  }
  return stats;
}
