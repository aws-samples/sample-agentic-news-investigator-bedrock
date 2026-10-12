// SPDX-License-Identifier: MIT-0
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";

/**
 * Same single-table conventions as v1's fin-store, against fin-v2-trading:
 *   PORTFOLIO / SNAPSHOT          {cash, realized_pnl_today, day_key}
 *   POSITION#<symbol> / -         {symbol, qty, avg_cost, kind}
 *   ORDER#<decision_id> / -       {payload, gsi1pk: SYM#<symbol>, gsi1sk: TS#<iso>}
 * Bookkeeping integrity only — the cash condition and the no-shorting guard
 * are accounting invariants, not a risk gate (v2 has none by design).
 */

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export interface Portfolio {
  cash: number;
  realized_pnl_today: number;
  day_key: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avg_cost: number;
  kind?: string;
  /** Maintained by the position watcher (watch.ts). */
  last_watch_price?: number;
  last_watch_at?: string;
}

export interface Fill {
  decisionId: string;
  newsId: string;
  symbol: string;
  kind: string;
  side: "buy" | "sell";
  qty: number;
  quotePrice: number;
  fillPrice: number;
  slippageBps: number;
  notionalUsd: number;
  quoteSource: string;
  realizedPnl: number;
  filledAt: string;
}

export async function getPortfolio(): Promise<Portfolio | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: config.table, Key: { pk: "PORTFOLIO", sk: "SNAPSHOT" } }),
  );
  return (r.Item as Portfolio | undefined) ?? null;
}

export async function getPosition(symbol: string): Promise<Position | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: config.table, Key: { pk: `POSITION#${symbol}`, sk: "-" } }),
  );
  return (r.Item as Position | undefined) ?? null;
}

export async function listPositions(table = config.table): Promise<Position[]> {
  const out: Position[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": "POSITION#" },
        ExclusiveStartKey: startKey,
      }),
    );
    // v1's Rust store keeps the symbol only in the partition key.
    out.push(
      ...(((r.Items ?? []) as (Position & { pk?: string })[]).map((i) => ({
        ...i,
        symbol: i.symbol ?? String(i.pk ?? "").slice("POSITION#".length),
      })) as Position[]),
    );
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out.filter((p) => p.qty !== 0);
}

export async function getPortfolioOf(table: string): Promise<Portfolio | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: table, Key: { pk: "PORTFOLIO", sk: "SNAPSHOT" } }),
  );
  return (r.Item as Portfolio | undefined) ?? null;
}

export async function recentTrades(symbol: string, limit = 20): Promise<Fill[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :s",
      ExpressionAttributeValues: { ":s": `SYM#${symbol}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return ((r.Items ?? []) as { payload: Fill }[]).map((i) => i.payload);
}

/**
 * Atomic 3-item fill: order put (idempotent on decision id), position upsert
 * with optimistic concurrency on qty, portfolio cash update guarded by
 * `cash >= :need` (DynamoDB conditions can't do arithmetic — compare, don't add).
 */
export async function recordFill(
  fill: Fill,
  position: { newQty: number; newAvgCost: number; expectedQty: number | null },
): Promise<void> {
  const cashDelta =
    fill.side === "buy"
      ? -(fill.qty * fill.fillPrice)
      : fill.qty * fill.fillPrice;

  const positionKey = { pk: `POSITION#${fill.symbol}`, sk: "-" };
  const positionWrite =
    position.newQty === 0
      ? {
          Delete: {
            TableName: config.table,
            Key: positionKey,
            ConditionExpression: "qty = :expected",
            ExpressionAttributeValues: { ":expected": position.expectedQty },
          },
        }
      : {
          Put: {
            TableName: config.table,
            Item: {
              ...positionKey,
              symbol: fill.symbol,
              kind: fill.kind,
              qty: position.newQty,
              avg_cost: position.newAvgCost,
            },
            ConditionExpression:
              position.expectedQty === null
                ? "attribute_not_exists(pk)"
                : "qty = :expected",
            ...(position.expectedQty === null
              ? {}
              : { ExpressionAttributeValues: { ":expected": position.expectedQty } }),
          },
        };

  const portfolioUpdate = {
    Update: {
      TableName: config.table,
      Key: { pk: "PORTFOLIO", sk: "SNAPSHOT" },
      UpdateExpression:
        "SET cash = cash + :delta ADD realized_pnl_today :pnl",
      ExpressionAttributeValues: {
        ":delta": cashDelta,
        ":pnl": fill.realizedPnl,
        ...(fill.side === "buy" ? { ":need": -cashDelta } : {}),
      },
      ...(fill.side === "buy" ? { ConditionExpression: "cash >= :need" } : {}),
    },
  };

  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: config.table,
            Item: {
              pk: `ORDER#${fill.decisionId}`,
              sk: "-",
              gsi1pk: `SYM#${fill.symbol}`,
              gsi1sk: `TS#${fill.filledAt}`,
              payload: fill,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        positionWrite,
        portfolioUpdate,
      ],
    }),
  );
}

/** Roll realized_pnl_today when the UTC day changes (best effort). */
export async function rollDay(dayKey: string): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: config.table,
        Key: { pk: "PORTFOLIO", sk: "SNAPSHOT" },
        UpdateExpression: "SET realized_pnl_today = :z, day_key = :d",
        ConditionExpression: "attribute_exists(pk) AND day_key <> :d",
        ExpressionAttributeValues: { ":z": 0, ":d": dayKey },
      }),
    )
    .catch(() => {}); // condition failure = already rolled
}

export { ddb };
