// SPDX-License-Identifier: MIT-0
/**
 * Kalshi market discovery for the v5 desk. Kalshi has no search endpoint (/search is a 404),
 * so this keeps an index of open events with their markets, refreshed at most hourly, and
 * scores them against the query's words. Sports and entertainment are left out of the index:
 * the desk trades macro, policy, commodities, politics, weather, crypto and company contracts.
 * Failures return an empty list; a stale index is used until a refresh succeeds.
 *
 * Shared across processes (since 2026-10-27): v5 and v6 run on the same host and each rebuilt the
 * same ~60-page index hourly, and Kalshi answered the second with HTTP 429 on every sweep. The
 * index now lives in one file (V2_KALSHI_CACHE, default ~/.cache/fin/kalshi-index.json; "off" =
 * per-process as before). A process reads the file when it is fresh; when it is stale, one process
 * rebuilds it under an exclusive lock file and the others keep their current copy meanwhile.
 */
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sourceEnabled } from "../sources.js";
const B = "https://api.elections.kalshi.com/trade-api/v2";
const UA = { "user-agent": "fin-v5/0.1" };
const SKIP_CATEGORIES = /^(sports|entertainment|social|mentions|exotics)$/i;
const REFRESH_MS = 60 * 60_000;

export interface KalshiHit {
  symbol: string;
  title: string;
  event: string;
  category: string;
  yesBid: number | null;
  yesAsk: number | null;
  volume24h: number | null;
  closes: string;
  /** When the market opened for trading; the as-of index filters on it. */
  opens?: string;
}

let index: KalshiHit[] = [];
let builtAt = 0;
let building: Promise<void> | null = null;

/** A lock older than this belongs to a builder that died; the next process takes it over. */
const LOCK_STALE_MS = 5 * 60_000;

export function cachePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.V2_KALSHI_CACHE;
  if (v === "off") return null;
  return v || join(env.HOME || homedir(), ".cache", "fin", "kalshi-index.json");
}

interface SharedIndex {
  builtAt: number;
  hits: KalshiHit[];
}

/** The shared file's contents, or null when it is missing, unreadable or empty. */
export function readShared(path: string): SharedIndex | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as SharedIndex;
    return Array.isArray(j.hits) && j.hits.length && Number.isFinite(j.builtAt) ? j : null;
  } catch {
    return null;
  }
}

/** Atomic for readers: write a sibling temp file, then rename over the old one. */
export function writeShared(path: string, data: SharedIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** Take the rebuild lock; false while another live process holds it. */
export function tryLock(lockPath: string, nowMs = Date.now()): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch {
    try {
      if (nowMs - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        closeSync(openSync(lockPath, "wx"));
        return true;
      }
    } catch {
      // another process won the race for the stale lock
    }
    return false;
  }
}

export function unlock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

const num = (x: unknown) => (x === undefined || x === null || x === "" ? null : Number(x));

async function build(): Promise<void> {
  const out = await fetchEvents("status=open");
  if (out.length) {
    index = out;
    builtAt = Date.now();
  }
}

// 74 pages of open events on 2026-10-27 (14,636 events); the old cap of 60 silently left ~19% out.
async function fetchEvents(filter: string, activeOnly = true, maxPages = 200): Promise<KalshiHit[]> {
  const out: KalshiHit[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    let r = await fetch(`${B}/events?${filter}&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ""}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
    for (let tries = 0; r.status === 429 && tries < 5; tries++) {
      await new Promise((res) => setTimeout(res, 2_000 * (tries + 1)));
      r = await fetch(`${B}/events?${filter}&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ""}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
    }
    if (!r.ok) throw new Error(`kalshi events HTTP ${r.status}`);
    const j: any = await r.json();
    for (const e of j.events ?? []) {
      if (SKIP_CATEGORIES.test(String(e.category ?? ""))) continue;
      for (const m of e.markets ?? []) {
        if (activeOnly && m.status && m.status !== "active" && m.status !== "open") continue;
        if (m.mve_collection_ticker) continue; // multi-leg combos
        out.push({
          symbol: `${m.ticker}:YES`,
          title: [e.title, m.yes_sub_title || m.subtitle || ""].filter(Boolean).join(" — ") || m.title,
          event: e.event_ticker,
          category: String(e.category ?? ""),
          yesBid: num(m.yes_bid_dollars),
          yesAsk: num(m.yes_ask_dollars),
          volume24h: num(m.volume_24h_fp ?? m.volume_24h),
          closes: m.close_time,
          opens: m.open_time,
        });
      }
    }
    cursor = j.cursor ?? "";
    if (!cursor) break;
    await new Promise((res) => setTimeout(res, 120));
  }
  if (cursor) console.warn(`[kalshi-search] ${filter}: stopped at ${maxPages} pages with more to read; the index is incomplete`);
  return out;
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9$.%]+/g) ?? [];

/** Pure: rank hits by the share of query words found in title/event/category, then by 24h volume. */
export function rankKalshi(hits: KalshiHit[], query: string, limit: number): KalshiHit[] {
  const q = [...new Set(words(query))].filter((w) => w.length > 1);
  if (!q.length) return [];
  const scored = hits
    .map((h) => {
      const hay = `${h.title} ${h.event} ${h.category}`.toLowerCase();
      const s = q.filter((w) => hay.includes(w)).length / q.length;
      return { h, s };
    })
    .filter((x) => x.s >= 0.5);
  scored.sort((a, b) => b.s - a.s || (b.h.volume24h ?? 0) - (a.h.volume24h ?? 0));
  return scored.slice(0, limit).map((x) => x.h);
}

async function refresh(): Promise<void> {
  const path = cachePath();
  if (!path) return build();
  const shared = readShared(path);
  if (shared && shared.builtAt > builtAt) {
    index = shared.hits;
    builtAt = shared.builtAt;
    if (Date.now() - builtAt <= REFRESH_MS) return; // another process refreshed it
  }
  const lock = `${path}.lock`;
  if (!tryLock(lock)) {
    // Another process is rebuilding. With nothing in hand (a fresh boot), wait for its file.
    for (let i = 0; !index.length && i < 15; i++) {
      await new Promise((res) => setTimeout(res, 2_000));
      const landed = readShared(path);
      if (landed) {
        index = landed.hits;
        builtAt = landed.builtAt;
      }
    }
    return;
  }
  try {
    await build();
    if (index.length) writeShared(path, { builtAt, hits: index });
  } finally {
    unlock(lock);
  }
}

async function ensureIndex(): Promise<void> {
  if (Date.now() - builtAt > REFRESH_MS) {
    building ??= refresh()
      .catch((e) => console.error("[kalshi-search] index refresh failed:", String(e).slice(0, 160)))
      .finally(() => (building = null));
    if (!index.length) await building;
  }
}

/** The most-traded open Kalshi markets (24 h volume), for the v5 sweep. */
export async function topKalshi(limit = 25): Promise<KalshiHit[]> {
  if (!sourceEnabled("kalshi")) return []; // opt-in source (sources.ts): no network call
  await ensureIndex();
  return [...index].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, limit);
}

export async function searchKalshi(query: string, limit = 8): Promise<KalshiHit[]> {
  if (!sourceEnabled("kalshi")) return [];
  await ensureIndex();
  return rankKalshi(index, query, limit);
}

/** Pure: the markets that were open at asOfMs (opened at or before it, closing after it). */
export function openAt(hits: KalshiHit[], asOfMs: number): KalshiHit[] {
  return hits.filter((h) => (!h.opens || Date.parse(h.opens) <= asOfMs) && Date.parse(h.closes) > asOfMs);
}

/**
 * Bench only: the markets open at asOfMs, with no prices (a later book would be lookahead).
 * Built once per process from every event closing after the earliest asOf asked for — open,
 * closed and settled — because a contract that has since closed was still tradeable then.
 */
let asOfIndex: { sinceMs: number; hits: Promise<KalshiHit[]> } | null = null;
export async function searchKalshiAsOf(query: string, asOfMs: number, limit = 8): Promise<KalshiHit[]> {
  if (!sourceEnabled("kalshi")) return [];
  if (!asOfIndex || asOfMs < asOfIndex.sinceMs) {
    const sinceMs = asOfMs - 86_400_000;
    const ts = Math.floor(sinceMs / 1000);
    // Sequential, each listing on its own: the settled one alone ran 61 pages for a two-day
    // window, and one rate-limited page used to empty the whole index without a word.
    const part = (f: string) =>
      fetchEvents(f, false, 400).catch((e) => {
        console.error(`[kalshi-search] as-of index: ${f} failed:`, String(e).slice(0, 160));
        return [] as KalshiHit[];
      });
    asOfIndex = {
      sinceMs,
      hits: (async () => [
        ...(await part("status=open")),
        ...(await part(`status=closed&min_close_ts=${ts}`)),
        ...(await part(`status=settled&min_close_ts=${ts}`)),
      ])(),
    };
  }
  const hits = openAt(await asOfIndex.hits, asOfMs).map((h) => ({ ...h, yesBid: null, yesAsk: null, volume24h: null }));
  return rankKalshi(hits, query, limit);
}
