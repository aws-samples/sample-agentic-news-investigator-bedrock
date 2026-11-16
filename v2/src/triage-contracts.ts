// SPDX-License-Identifier: MIT-0
/**
 * Prediction-desk triage gets the open contracts that match an item's subjects
 * (V2_TRIAGE_CONTRACTS=1). Triage used to guess whether a contract existed, and guessed
 * inconsistently: on Hurricane Vance advisory 11 (2026-10-24) v6's Haiku wrote "no
 * prediction-market contracts track regional Mexican hurricane impacts" and scored 0.05,
 * while Kalshi lists a category market for every name on the season's list and Polymarket
 * had "Will Vance peak at Category 3?" — the contracts v5 then made money on, after its own
 * triage scored the same cycle 0.72 for a Gulf-oil theory that did not apply.
 *
 * Titles and symbols only, never prices: triage judges whether the news moves a contract
 * that exists, the investigation reads the book. With asOfMs (the bench) only contracts that
 * existed and were open at that instant are listed. Every failure is an empty list.
 */
import { attentionKey } from "./recent.js";
import { searchKalshi, searchKalshiAsOf } from "./quotes/kalshi-search.js";
import { searchMarkets } from "./quotes/prediction.js";
import type { NewsItem } from "./types.js";

export interface OpenContract {
  symbol: string;
  venue: "kalshi" | "polymarket";
  title: string;
  closes?: string;
}

export interface SubjectQuery {
  /** What is sent to the venue search. */
  q: string;
  /** Words a hit's title must all contain (lowercase). */
  must: string[];
  /** When set, a hit's title must also match this (storm names collide with people: JD Vance). */
  also?: RegExp;
}

const STORM_WORDS = /hurricane|tropical|storm|cyclone|typhoon|category|landfall/i;

/** Acronyms whose contracts are titled by country, not by the acronym. */
const ALIASES: Record<string, string> = {
  fed: "fed",
  fomc: "fed",
  rbnz: "new zealand",
  rba: "australia",
  boj: "japan",
  boe: "england",
  boc: "canada",
  ecb: "ecb",
  snb: "switzerland",
  opec: "opec",
};

/** Capitalized words that open headlines without naming anything. */
const GENERIC = new Set(
  "a an the of in on at to for and or as by with from after before over under amid says said say update updates breaking weekend live watch report reports new news public advisory forecast discussion number summary graphics wind speed probabilities statement press release ltd inc corp plc co company group holdings us u.s. uk eu".split(" "),
);

const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9$.%]+/g) ?? [];

/** Pure: the venue queries an item's subjects call for (at most three). */
export function subjectQueries(item: Pick<NewsItem, "headline" | "source_family">): SubjectQuery[] {
  const storm = attentionKey(item.headline, item.source_family);
  if (storm) {
    const name = storm.subject.replace(/^storm:/, "");
    // "hurricane vance", not "vance": Polymarket's search ranks JD Vance first for the bare name.
    return [{ q: `hurricane ${name}`, must: [name], also: STORM_WORDS }];
  }
  const out: SubjectQuery[] = [];
  const seen = new Set<string>();
  const push = (q: string, must: string[]) => {
    if (seen.has(q) || out.length >= 3) return;
    seen.add(q);
    out.push({ q, must });
  };
  for (const w of item.headline.match(/\b[A-Za-z]{2,6}\b/g) ?? []) {
    const alias = ALIASES[w.toLowerCase()];
    if (alias && (w === w.toUpperCase() || w === "Fed")) push(alias, tokens(alias));
  }
  // Runs of Capitalized words ("Reserve Bank of New Zealand", "Iran", "Nvidia"), longest first.
  const runs = item.headline.match(/\b[A-Z][\w'.-]*(?:\s+(?:of|the|de|and)?\s*[A-Z][\w'.-]*)*/g) ?? [];
  const phrases = runs
    .map((r) => tokens(r).filter((t) => !GENERIC.has(t) && t.length > 2))
    .filter((t) => t.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const t of phrases) push(t.join(" "), t);
  return out;
}

/** Pure: keep hits whose title names the subject. */
export function matchesSubject(title: string, q: SubjectQuery): boolean {
  const t = title.toLowerCase();
  return q.must.every((w) => t.includes(w)) && (!q.also || q.also.test(title));
}

export async function contractsFor(
  item: Pick<NewsItem, "headline" | "source_family">,
  opts: { asOfMs?: number; limit?: number; timeoutMs?: number } = {},
): Promise<OpenContract[]> {
  const limit = opts.limit ?? 8;
  const queries = subjectQueries(item);
  if (!queries.length) return [];
  const work = (async () => {
    const out: OpenContract[] = [];
    const seen = new Set<string>();
    for (const q of queries) {
      const [kalshi, poly] = await Promise.all([
        (opts.asOfMs !== undefined ? searchKalshiAsOf(q.q, opts.asOfMs, 6) : searchKalshi(q.q, 6)).catch(() => []),
        searchMarkets(q.q, 10, opts.asOfMs !== undefined ? { asOfMs: opts.asOfMs } : {}).catch(() => []),
      ]);
      const hits: OpenContract[] = [
        ...kalshi.map((h) => ({ symbol: h.symbol, venue: "kalshi" as const, title: h.title, closes: h.closes })),
        ...poly.map((h) => ({ symbol: h.symbol, venue: "polymarket" as const, title: h.question, closes: h.close_time })),
      ];
      for (const h of hits) {
        if (seen.has(h.symbol) || !matchesSubject(`${h.title} ${h.symbol.replace(/-/g, " ")}`, q)) continue;
        seen.add(h.symbol);
        out.push({ ...h, title: h.title.slice(0, 140) });
      }
    }
    return out.slice(0, limit);
  })();
  const timeout = new Promise<OpenContract[]>((res) => setTimeout(() => res([]), opts.timeoutMs ?? 8_000).unref?.());
  return Promise.race([work, timeout]).catch(() => []);
}
