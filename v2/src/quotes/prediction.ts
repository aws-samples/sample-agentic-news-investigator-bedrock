// SPDX-License-Identifier: MIT-0
import type { Quote } from "../types.js";
import { sourceEnabled } from "../sources.js";

/**
 * Prediction venues, ported from v1 (crates/fin-md). Symbol format:
 * "<kalshi-ticker|polymarket-slug>:YES|NO". Kalshi tickers are
 * SCREAMING-KEBAB; Polymarket slugs are lowercase.
 */
export function splitSide(symbol: string): { id: string; yes: boolean } | null {
  const idx = symbol.lastIndexOf(":");
  if (idx < 0) return null;
  const side = symbol.slice(idx + 1).toUpperCase();
  if (side !== "YES" && side !== "NO") return null;
  return { id: symbol.slice(0, idx), yes: side === "YES" };
}

/** Kalshi: prices come from the *_dollars decimal-string fields (verified 2026-08-01). */
export function parseKalshiMarket(
  body: unknown,
  symbol: string,
  yes: boolean,
): Quote | null {
  const m = (body as any)?.market;
  if (!m) return null;
  const dec = (key: string): number | undefined => {
    const v = Number(m[key]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const bid = yes ? dec("yes_bid_dollars") : dec("no_bid_dollars");
  const ask = yes ? dec("yes_ask_dollars") : dec("no_ask_dollars");
  const last = dec("last_price_dollars");
  const price =
    bid !== undefined && ask !== undefined ? (bid + ask) / 2 : last;
  if (price === undefined) return null;
  const liq = Number(m.liquidity_dollars);
  return {
    symbol,
    kind: "prediction",
    price,
    bid,
    ask,
    asOfMs: Date.now(),
    source: "kalshi",
    liquidityUsd: Number.isFinite(liq) ? liq : undefined,
  };
}

export async function kalshiQuote(symbol: string): Promise<Quote | null> {
  if (!sourceEnabled("kalshi")) return null; // opt-in source (sources.ts)
  const parts = splitSide(symbol);
  if (!parts) return null;
  try {
    const resp = await fetch(
      `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(parts.id)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) return null;
    return parseKalshiMarket(await resp.json(), symbol, parts.yes);
  } catch {
    return null;
  }
}

/**
 * Polymarket Gamma: bestBid/bestAsk are the YES book; NO is the complement.
 * outcomePrices is a JSON-encoded string array (verified 2026-08-01).
 */
export function parsePolymarket(
  body: unknown,
  symbol: string,
  yes: boolean,
): Quote | null {
  const m = Array.isArray(body) ? (body as any[])[0] : undefined;
  if (!m) return null;
  // Resolved market: price is the payout for our side, no book.
  if (m.closed === true) {
    const r = parsePolymarketResolution(body, yes);
    if (r.resolved && r.payout !== undefined) {
      return {
        symbol,
        kind: "prediction",
        price: r.payout,
        asOfMs: Date.now(),
        source: "polymarket",
        liquidityUsd: 0,
        resolved: true,
      };
    }
  }
  const yesBid = typeof m.bestBid === "number" ? m.bestBid : undefined;
  const yesAsk = typeof m.bestAsk === "number" ? m.bestAsk : undefined;
  const bid = yes ? yesBid : yesAsk !== undefined ? 1 - yesAsk : undefined;
  const ask = yes ? yesAsk : yesBid !== undefined ? 1 - yesBid : undefined;
  let price: number | undefined =
    bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
  if (price === undefined && typeof m.outcomePrices === "string") {
    try {
      const arr = JSON.parse(m.outcomePrices) as string[];
      const p = Number(arr[yes ? 0 : 1]);
      if (Number.isFinite(p)) price = p;
    } catch {
      // fall through
    }
  }
  if (price === undefined) return null;
  const liq = Number(m.liquidityNum ?? m.liquidity);
  return {
    symbol,
    kind: "prediction",
    price,
    bid,
    ask,
    asOfMs: Date.now(),
    source: "polymarket",
    liquidityUsd: Number.isFinite(liq) ? liq : undefined,
  };
}

/**
 * Gamma's slug lookup HIDES closed markets unless `closed=true` is passed
 * (verified 2026-09-01: a resolved market returned [] by slug, then appeared
 * with closed=true). Try open first, then closed — so resolved positions
 * quote at their payout and the settlement pass can see them.
 */
async function fetchPolymarketBySlug(slug: string): Promise<unknown | null> {
  if (!sourceEnabled("polymarket")) return null; // opt-in source (sources.ts)
  for (const suffix of ["", "&closed=true"]) {
    try {
      const resp = await fetch(
        `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}${suffix}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) continue;
      const body = await resp.json();
      if (Array.isArray(body) && body.length > 0) return body;
    } catch {
      // try next
    }
  }
  return null;
}

export async function polymarketQuote(symbol: string): Promise<Quote | null> {
  const parts = splitSide(symbol);
  if (!parts) return null;
  const body = await fetchPolymarketBySlug(parts.id);
  return body ? parsePolymarket(body, symbol, parts.yes) : null;
}

export interface ResolutionStatus {
  resolved: boolean;
  /** 1 or 0 (USD per contract for OUR side) when resolved. */
  payout?: number;
}

/** Polymarket: closed markets report outcomePrices pinned to ["1","0"]/["0","1"]. */
export function parsePolymarketResolution(body: unknown, yes: boolean): ResolutionStatus {
  const m = Array.isArray(body) ? (body as any[])[0] : undefined;
  if (!m || m.closed !== true) return { resolved: false };
  try {
    const arr = JSON.parse(m.outcomePrices) as string[];
    const p = Number(arr[yes ? 0 : 1]);
    if (!Number.isFinite(p)) return { resolved: false };
    return { resolved: true, payout: p >= 0.5 ? 1 : 0 };
  } catch {
    return { resolved: false };
  }
}

/** Kalshi: status moves to settled/finalized with result "yes"|"no". */
export function parseKalshiResolution(body: unknown, yes: boolean): ResolutionStatus {
  const m = (body as any)?.market;
  const status = String(m?.status ?? "").toLowerCase();
  if (status !== "settled" && status !== "finalized") return { resolved: false };
  const result = String(m?.result ?? "").toLowerCase();
  if (result !== "yes" && result !== "no") return { resolved: false };
  return { resolved: true, payout: (result === "yes") === yes ? 1 : 0 };
}

/** Has this contract resolved? Checked by the position watcher for settlement. */
export async function checkResolution(symbol: string): Promise<ResolutionStatus> {
  const parts = splitSide(symbol);
  if (!parts) return { resolved: false };
  const kalshiFirst = parts.id === parts.id.toUpperCase();
  try {
    if (kalshiFirst) {
      if (!sourceEnabled("kalshi")) return { resolved: false };
      const resp = await fetch(
        `https://api.elections.kalshi.com/trade-api/v2/markets/${encodeURIComponent(parts.id)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (resp.ok) return parseKalshiResolution(await resp.json(), parts.yes);
    } else {
      const body = await fetchPolymarketBySlug(parts.id);
      if (body) return parsePolymarketResolution(body, parts.yes);
    }
  } catch {
    // network failure: not resolved as far as we can tell
  }
  return { resolved: false };
}

export interface MarketHit {
  symbol: string;
  venue: string;
  question: string;
  yes_price?: string;
  volume?: string;
  close_time?: string;
}

/**
 * Free-text discovery via Polymarket public-search (Kalshi has no public
 * search endpoint — probed 404 2026-08-01; Kalshi symbols quote directly).
 */
export async function searchMarkets(query: string, limit = 8): Promise<MarketHit[]> {
  if (!sourceEnabled("polymarket")) return [];
  const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(
    query,
  )}&limit_per_type=${Math.min(Math.max(limit, 1), 10)}`;
  const hits: MarketHit[] = [];
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return hits;
    const body: any = await resp.json();
    for (const ev of body?.events ?? []) {
      for (const m of ev?.markets ?? []) {
        if (m?.closed) continue;
        if (typeof m?.slug !== "string") continue;
        let yesPrice: string | undefined;
        if (typeof m.outcomePrices === "string") {
          try {
            yesPrice = (JSON.parse(m.outcomePrices) as string[])[0];
          } catch {
            // ignore
          }
        }
        hits.push({
          symbol: `${m.slug}:YES`,
          venue: "polymarket",
          question: typeof m.question === "string" ? m.question : m.slug,
          yes_price: yesPrice,
          volume: typeof m.volume === "string" ? m.volume : undefined,
          close_time: typeof m.endDate === "string" ? m.endDate : undefined,
        });
        if (hits.length >= limit) return hits;
      }
    }
  } catch {
    // return what we have
  }
  return hits;
}
