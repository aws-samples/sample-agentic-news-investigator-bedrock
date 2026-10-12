// SPDX-License-Identifier: MIT-0
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";
import { resolve } from "./quotes/resolver.js";
import { splitSide, type MarketHit } from "./quotes/prediction.js";
import type { InstrumentKind, NewsItem, ResolvedInstrument, Resolution } from "./types.js";

/**
 * The quote tape: every price either arm observes, persisted at the moment it
 * is observed. Until 2026-09-04 the only prices the system kept were fills and
 * a position's last watch price; everything the resolver returned during an
 * investigation was thrown away, so the replay bench had to price archived
 * events with LIVE quotes and its trade returns were directional evidence only.
 * With the tape, the bench can resolve as-of the event.
 *
 * One table (fin-quote-tape, `config.tapeTable`), shared by v2 and v3, TTL 90
 * days to match the bus archive:
 *   QUOTE#<symbol>        / TS#<captured_at>   one observed quote (any origin)
 *   MARKET#<slug-or-id>   / TS#<captured_at>   a Polymarket search hit (they vanish once closed)
 *   EVENT#<news_id>       / SNAP               the NewsItem + triage verdict + symbols at ingest
 *
 * `captured_at` is OUR clock (when we saw it); `asOfMs` is the venue's own
 * timestamp from the Quote. ISO strings from toISOString() sort
 * lexicographically, which is what the as-of reader relies on.
 *
 * The write side never throws: the live path must not fail because the tape
 * did. A missing table is logged once per process and disables writes.
 */

export type TapeOrigin = "ingest" | "tool" | "watch" | "search";

export interface TapeQuote {
  symbol: string;
  kind: InstrumentKind;
  price: number;
  bid?: number;
  ask?: number;
  /** The venue's own timestamp (from the Quote). */
  asOfMs: number;
  source: string;
  liquidityUsd?: number;
  resolved?: boolean;
  hasBook: boolean;
  ageSecs: number;
  indicativeOnly: boolean;
  note?: string;
  /** When we observed it (ISO). */
  captured_at: string;
  news_id?: string;
  origin: TapeOrigin;
  arm: string;
  /** Epoch seconds; the table's TTL attribute. */
  expires_at: number;
}

export interface TapeMarket extends MarketHit {
  captured_at: string;
  news_id?: string;
  arm: string;
  expires_at: number;
}

export interface EventSnapshot {
  news_id: string;
  item: NewsItem;
  triage: unknown;
  symbols: string[];
  captured_at: string;
  arm: string;
  expires_at: number;
}

const TTL_DAYS = 90;
const DEFAULT_MAX_AGE_MS = 6 * 3_600_000;

// ---------- pure helpers (exported for tests) ----------

export function quoteKey(symbol: string, capturedAtIso: string): { pk: string; sk: string } {
  return { pk: `QUOTE#${symbol}`, sk: `TS#${capturedAtIso}` };
}

export function marketKey(slugOrId: string, capturedAtIso: string): { pk: string; sk: string } {
  return { pk: `MARKET#${slugOrId}`, sk: `TS#${capturedAtIso}` };
}

export function eventKey(newsId: string): { pk: string; sk: string } {
  return { pk: `EVENT#${newsId}`, sk: "SNAP" };
}

export function ttlEpoch(nowMs: number, days = TTL_DAYS): number {
  return Math.floor(nowMs / 1000) + days * 86_400;
}

/** A MarketHit's symbol is `<slug>:YES`; the row is keyed by the slug alone. */
export function marketId(hit: Pick<MarketHit, "symbol">): string {
  return splitSide(hit.symbol)?.id ?? hit.symbol;
}

export function toTapeQuote(
  res: ResolvedInstrument,
  ctx: { newsId?: string; origin: TapeOrigin; arm: string; capturedAt: string },
): TapeQuote {
  const q = res.quote;
  return {
    symbol: q.symbol,
    kind: q.kind,
    price: q.price,
    ...(q.bid !== undefined ? { bid: q.bid } : {}),
    ...(q.ask !== undefined ? { ask: q.ask } : {}),
    asOfMs: q.asOfMs,
    source: q.source,
    ...(q.liquidityUsd !== undefined ? { liquidityUsd: q.liquidityUsd } : {}),
    ...(q.resolved !== undefined ? { resolved: q.resolved } : {}),
    hasBook: res.meta.hasBook,
    ageSecs: res.meta.ageSecs,
    indicativeOnly: res.meta.indicativeOnly,
    ...(res.meta.note !== undefined ? { note: res.meta.note } : {}),
    captured_at: ctx.capturedAt,
    ...(ctx.newsId !== undefined ? { news_id: ctx.newsId } : {}),
    origin: ctx.origin,
    arm: ctx.arm,
    expires_at: ttlEpoch(Date.parse(ctx.capturedAt)),
  };
}

// ---------- write side (never throws) ----------

let writesDisabled = false;

/**
 * The single write path. A missing table (not yet deployed, wrong region) is
 * logged once and then silences the tape for the rest of the process; any
 * other failure is logged and dropped. Nothing here ever rejects.
 */
async function putTapeItem(item: Record<string, unknown>): Promise<void> {
  if (writesDisabled) return;
  try {
    await ddb.send(new PutCommand({ TableName: config.tapeTable, Item: item }));
  } catch (e: any) {
    if (e?.name === "ResourceNotFoundException") {
      writesDisabled = true;
      console.error(
        `[tape] table ${config.tapeTable} not found — quote tape disabled for this process ` +
          `(deploy the stack, or set V2_TAPE_TABLE)`,
      );
      return;
    }
    console.error(`[tape] write failed (${String(item.pk ?? "?")}):`, e?.message ?? e);
  }
}

/** Record one resolver result. No-op when the instrument did not resolve. */
export async function recordResolution(
  res: Resolution,
  ctx: { newsId?: string; origin: TapeOrigin },
): Promise<void> {
  if (!res.ok) return;
  try {
    const capturedAt = new Date().toISOString();
    const row = toTapeQuote(res, { ...ctx, arm: config.arm, capturedAt });
    await putTapeItem({ ...quoteKey(row.symbol, capturedAt), ...row });
  } catch (e) {
    console.error("[tape] recordResolution failed:", e);
  }
}

/** Record Polymarket search hits; they vanish from public-search once a market closes. */
export async function recordMarkets(hits: MarketHit[], ctx: { newsId?: string } = {}): Promise<void> {
  if (hits.length === 0) return;
  try {
    const capturedAt = new Date().toISOString();
    const expires = ttlEpoch(Date.parse(capturedAt));
    await Promise.all(
      hits.map((hit) => {
        const row: TapeMarket = {
          ...hit,
          captured_at: capturedAt,
          ...(ctx.newsId !== undefined ? { news_id: ctx.newsId } : {}),
          arm: config.arm,
          expires_at: expires,
        };
        return putTapeItem({ ...marketKey(marketId(hit), capturedAt), ...row });
      }),
    );
  } catch (e) {
    console.error("[tape] recordMarkets failed:", e);
  }
}

/** The event as the worker saw it: item, triage verdict, and the symbols snapshotted at ingest. */
export async function recordEventSnapshot(
  item: NewsItem,
  triage: unknown,
  symbols: string[],
): Promise<void> {
  try {
    const capturedAt = new Date().toISOString();
    const row: EventSnapshot = {
      news_id: item.id,
      item,
      triage,
      symbols,
      captured_at: capturedAt,
      arm: config.arm,
      expires_at: ttlEpoch(Date.parse(capturedAt)),
    };
    await putTapeItem({ ...eventKey(item.id), ...row });
  } catch (e) {
    console.error("[tape] recordEventSnapshot failed:", e);
  }
}

export type TapeRecorder = (
  res: ResolvedInstrument,
  ctx: { newsId?: string; origin: TapeOrigin },
) => Promise<void>;

/**
 * Ingest snapshot: resolve each symbol (default: the live resolver, kind
 * "auto") and record what came back with origin "ingest", so the bench has a
 * price from the minute the news arrived. Capped at `max` symbols; the whole
 * pass is bounded by `timeoutMs` — whatever has not resolved by then is left
 * to finish (and still be recorded) in the background. Returns the canonical
 * symbols that resolved before the deadline. Never throws.
 */
export async function snapshotSymbols(
  symbols: string[],
  newsId: string,
  opts: { resolveFn?: typeof resolve; max?: number; timeoutMs?: number; record?: TapeRecorder } = {},
): Promise<string[]> {
  const resolveFn = opts.resolveFn ?? resolve;
  const record = opts.record ?? recordResolution;
  const max = opts.max ?? 6;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const unique = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))].slice(0, max);
  const resolved: string[] = [];
  if (unique.length === 0) return resolved;

  const work = Promise.allSettled(
    unique.map(async (symbol) => {
      const res = await resolveFn(symbol, "auto");
      if (!res.ok) return;
      resolved.push(res.quote.symbol);
      await record(res, { newsId, origin: "ingest" });
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((r) => {
    timer = setTimeout(r, timeoutMs);
  });
  try {
    await Promise.race([work, deadline]);
  } catch (e) {
    console.error(`[tape] snapshotSymbols(${newsId}) failed:`, e);
  } finally {
    clearTimeout(timer);
  }
  return [...resolved];
}

// ---------- read side (the as-of resolver and the bench) ----------

function stripKey<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as T;
}

/**
 * The nearest quote captured at or before `asOfMs`, provided it is no older
 * than `maxAgeMs` (default 6 h) relative to that instant. One Query, newest
 * first, limit 1.
 */
export async function quoteAsOf(
  symbol: string,
  asOfMs: number,
  opts: { maxAgeMs?: number; table?: string } = {},
): Promise<TapeQuote | null> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const r = await ddb.send(
    new QueryCommand({
      TableName: opts.table ?? config.tapeTable,
      KeyConditionExpression: "pk = :pk AND sk <= :sk",
      ExpressionAttributeValues: {
        ":pk": `QUOTE#${symbol}`,
        ":sk": `TS#${new Date(asOfMs).toISOString()}`,
      },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const item = r.Items?.[0] as Record<string, unknown> | undefined;
  if (!item) return null;
  const capturedMs = Date.parse(String(item.captured_at ?? ""));
  if (!Number.isFinite(capturedMs) || asOfMs - capturedMs > maxAgeMs) return null;
  return stripKey<TapeQuote>(item);
}

/**
 * Markets observed at or before `asOfMs` whose question or slug contains any
 * of the query's words (case-insensitive substring). Ranked by how many words
 * matched, then by most recent capture; one row (the latest capture) per
 * market; up to `limit`. A Scan with a begins_with filter: the table is small
 * and the bench is offline.
 */
export async function marketsAsOf(
  query: string,
  asOfMs: number,
  opts: { limit?: number; table?: string } = {},
): Promise<MarketHit[]> {
  const limit = opts.limit ?? 8;
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  const cutoff = `TS#${new Date(asOfMs).toISOString()}`;

  const latest = new Map<string, TapeMarket & { pk: string }>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: opts.table ?? config.tapeTable,
        FilterExpression: "begins_with(pk, :p) AND sk <= :cutoff",
        ExpressionAttributeValues: { ":p": "MARKET#", ":cutoff": cutoff },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const raw of (r.Items ?? []) as (TapeMarket & { pk: string })[]) {
      const prev = latest.get(raw.pk);
      if (!prev || raw.captured_at > prev.captured_at) latest.set(raw.pk, raw);
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);

  const scored: { hit: MarketHit; score: number; captured_at: string }[] = [];
  for (const row of latest.values()) {
    const haystack = `${row.question ?? ""} ${row.pk.slice("MARKET#".length)}`.toLowerCase();
    const score = words.reduce((n, w) => (haystack.includes(w) ? n + 1 : n), 0);
    if (score === 0) continue;
    const { pk: _pk, sk: _sk, captured_at, news_id: _n, arm: _a, expires_at: _e, ...hit } =
      row as TapeMarket & { pk: string; sk?: string };
    scored.push({ hit: hit as MarketHit, score, captured_at });
  }
  scored.sort((a, b) => b.score - a.score || (a.captured_at < b.captured_at ? 1 : -1));
  return scored.slice(0, limit).map((s) => s.hit);
}

export async function eventSnapshot(
  newsId: string,
  table = config.tapeTable,
): Promise<EventSnapshot | null> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: eventKey(newsId) }));
  return r.Item ? stripKey<EventSnapshot>(r.Item as Record<string, unknown>) : null;
}
