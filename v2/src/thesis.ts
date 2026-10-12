// SPDX-License-Identifier: MIT-0
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";

/**
 * Cross-episode memory: every decision that references a symbol updates that
 * symbol's standing THESIS item (latest rationale + a short history). Pushed
 * into subsequent investigations so the agent reasons "does this new fact
 * break my entry thesis?" instead of re-deriving the world from scratch —
 * better position management and fewer turns on no-change events.
 */

export interface ThesisEntry {
  at: string;
  action: string;
  confidence: number;
  trigger: string; // source_family of the triggering event
  rationale: string;
}

export interface Thesis {
  symbol: string;
  latest: ThesisEntry;
  history: ThesisEntry[];
}

const LATEST_RATIONALE_MAX = 600;
const HISTORY_RATIONALE_MAX = 200;
const HISTORY_MAX = 8;

export function compactEntry(e: ThesisEntry, maxRationale: number): ThesisEntry {
  return { ...e, rationale: e.rationale.slice(0, maxRationale) };
}

export async function getThesis(symbol: string): Promise<Thesis | null> {
  const r = await ddb.send(
    new GetCommand({ TableName: config.table, Key: { pk: `THESIS#${symbol}`, sk: "-" } }),
  );
  return (r.Item as Thesis | undefined) ?? null;
}

export async function getTheses(symbols: string[]): Promise<Thesis[]> {
  const out = await Promise.all(symbols.map((s) => getThesis(s).catch(() => null)));
  return out.filter((t): t is Thesis => t !== null);
}

export async function recordThesis(symbol: string, entry: ThesisEntry): Promise<void> {
  const existing = await getThesis(symbol);
  const history = existing
    ? [compactEntry(existing.latest, HISTORY_RATIONALE_MAX), ...existing.history].slice(
        0,
        HISTORY_MAX,
      )
    : [];
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        pk: `THESIS#${symbol}`,
        sk: "-",
        symbol,
        latest: compactEntry(entry, LATEST_RATIONALE_MAX),
        history,
      },
    }),
  );
}
