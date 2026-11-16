// SPDX-License-Identifier: MIT-0
/**
 * v5's market-first sweep: every config.sweepIntervalMin minutes, one investigation that starts
 * from the markets instead of from a headline. It gets the material news this desk triaged in the
 * last hours and the most-traded open contracts on Polymarket and Kalshi (price, 24 h change), and
 * is asked which contracts that news should have repriced and has not. It goes through
 * investigateAndAct like every other trigger, so it is audited, scored and executed identically.
 *
 * Why: v3's best trade (Fed hike by September, Sep 4) came from noticing that one venue had not
 * moved after payrolls; a news-first worker only sees the headline, never the contract that
 * failed to react to an earlier one.
 */
import { config } from "./config.js";
import { checkBudget } from "./budget.js";
import { investigateAndAct } from "./pipeline.js";
import { putAudit } from "./audit.js";
import { topKalshi } from "./quotes/kalshi-search.js";
import type { WebSearch } from "./websearch.js";
import type { NewsItem } from "./types.js";
import { sourceEnabled } from "./sources.js";

interface Noted {
  at: string;
  headline: string;
  materiality: number;
  event_type: string;
  hypotheses: string[];
}
const recent: Noted[] = [];
const KEEP_HOURS = 8;

/** Called by the worker after triage: material items feed the next sweep. */
export function noteForSweep(item: NewsItem, v: { materiality: number; event_type: string; hypotheses: string[] }): void {
  if (v.materiality < 0.5) return;
  recent.push({ at: item.published_at || new Date().toISOString(), headline: item.headline.slice(0, 200), materiality: v.materiality, event_type: v.event_type, hypotheses: v.hypotheses.slice(0, 3) });
  const cut = Date.now() - KEEP_HOURS * 3_600_000;
  while (recent.length && Date.parse(recent[0].at) < cut) recent.shift();
}

/**
 * Pure: the headlines still inside the sweep's window. noteForSweep only trims on a new material
 * item, so on a quiet weekend the same three Oct 23 headlines rode ~25 sweeps "in the last 8h" and
 * each sweep correctly called them priced in (v5 and v6, 2026-10-23 → 10-25).
 */
export function freshNews<T extends { at: string }>(items: readonly T[], nowMs: number, keepHours = KEEP_HOURS): T[] {
  const cut = nowMs - keepHours * 3_600_000;
  return items.filter((n) => Date.parse(n.at) >= cut);
}

const POLY_TAGS = ["economy", "fed", "geopolitics", "commodities", "politics", "crypto", "world", "finance"];

async function topPolymarket(limit: number): Promise<object[]> {
  if (!sourceEnabled("polymarket")) return []; // opt-in source (sources.ts): no network call
  const byId = new Map<string, any>();
  for (const tag of POLY_TAGS) {
    const r = await fetch(`https://gamma-api.polymarket.com/events?tag_slug=${tag}&closed=false&active=true&order=volume24hr&ascending=false&limit=15`, {
      headers: { "user-agent": "fin-v5/0.1" },
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    const ev: any[] = r?.ok ? await r.json() : [];
    for (const e of ev)
      for (const m of e.markets ?? []) {
        if (m.closed || !m.slug) continue;
        byId.set(m.slug, {
          symbol: `${m.slug}:YES`,
          question: m.question,
          yes: Number(m.lastTradePrice ?? m.bestAsk ?? NaN) || null,
          bid: Number(m.bestBid ?? NaN) || null,
          ask: Number(m.bestAsk ?? NaN) || null,
          change_24h: Number(m.oneDayPriceChange ?? NaN) || 0,
          volume_24h: Math.round(Number(m.volume24hr ?? 0)),
          ends: m.endDate,
        });
      }
  }
  return [...byId.values()].sort((a, b) => b.volume_24h - a.volume_24h).slice(0, limit);
}

export async function sweepPass(web: WebSearch | null): Promise<void> {
  const budget = await checkBudget({ priority: false });
  if (!budget.allowed) {
    console.warn(`[sweep] skipping: ${budget.reason}`);
    return;
  }
  const [poly, kalshi] = await Promise.all([topPolymarket(40).catch(() => []), topKalshi(25).catch(() => [])]);
  const now = new Date().toISOString();
  const id = `sweep-${Date.now()}`;
  const news = freshNews(recent, Date.now()).reverse().slice(0, 20);
  const item: NewsItem = {
    id,
    source_family: "sweep",
    source_id: "market-sweep",
    published_at: now,
    ingested_at: now,
    headline: `Market sweep: ${news.length} material headline${news.length === 1 ? "" : "s"} in the last ${KEEP_HOURS}h against the most-traded open contracts`,
    summary: JSON.stringify({
      task:
        "Start from the markets. For each material headline below, name the open contracts it should have repriced, " +
        "check whether they did (price, 24h change, the book), and trade any that have not moved enough — or are " +
        "mispriced for another reason you can evidence. Also re-check held contracts against the same news. If nothing " +
        "is mispriced, hold in one line naming what you checked.",
      material_news: news,
      polymarket_top: poly,
      kalshi_top: kalshi,
    }),
    url: "",
    tickers_hint: [],
    asset_class_hint: "prediction",
  };
  await putAudit(id, "v5-sweep", { headlines: news.length, polymarket: poly.length, kalshi: kalshi.length }).catch(() => {});
  console.log(`[sweep] investigating (${news.length} headlines, ${poly.length} Polymarket + ${kalshi.length} Kalshi contracts)`);
  await investigateAndAct(item, ["Which open contracts did recent news fail to reprice?"], web);
}
