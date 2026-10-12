// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import type { RecentInvestigation } from "./triage.js";
import type { TradeDecision } from "./types.js";
import type { WatchIdea } from "./mandate.js";

/**
 * Attention management for the news path (in-memory; resets on restart):
 *  - dedupe before paying for triage at all;
 *  - recent investigations: what the agent already looked at and decided,
 *    handed to triage so routine updates of an investigated story score low.
 *
 * Exact-headline dedupe was not enough. A single NHC advisory cycle arrives as
 * five to seven separate items with different headlines and the same content —
 * "Hurricane Karina Public Advisory Number 26", "... Forecast Advisory Number
 * 26", "... Wind Speed Probabilities Number 28", "... Graphics", "Summary for
 * Hurricane Karina (EP1/EP112026)" — so nothing collapsed and three of the
 * first eighteen live equity investigations were re-adjudications of a cycle
 * decided seconds earlier. Dedupe therefore keys on (storm, advisory cycle),
 * not on the headline text.
 */

export function normalizeHeadline(h: string): string {
  return h.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Products within one cycle, ranked by how much they can change a decision.
 * A cycle is triaged once, but a *more* informative product still gets through:
 * feed order is not guaranteed, and dropping the Public Advisory because the
 * Graphics arrived first would be worse than the duplication it prevents.
 */
const PRODUCT_RANK: [RegExp, number][] = [
  [/\b(public|forecast) advisory\b/i, 3],
  [/\bforecast discussion\b/i, 3],
  [/\b(tropical cyclone )?update\b/i, 3],
  [/\bwind speed probabilities\b/i, 1],
  [/\bgraphics\b/i, 1],
  [/\b(storm surge|watch\/warning|flooding) map\b/i, 1],
  [/^summary for\b/i, 1],
];

const DESIGNATION =
  /(?:potential )?(?:sub)?tropical (?:storm|depression|cyclone)|post-tropical cyclone|remnants of|major hurricane|hurricane|typhoon/i;

export interface AttentionKey {
  /** Stable across designation changes: Tropical Storm Edouard -> Hurricane Edouard. */
  subject: string;
  /** The advisory number ("26", "3a"), or null for undated products. */
  cycle: string | null;
  rank: number;
}

/**
 * The (storm, cycle) a headline belongs to, or null when plain headline dedupe
 * applies. GDACS phrases the same storm differently ("tropical cyclone
 * FIVE-26"); the numeric suffix is the season, so stripping it lands on the same
 * subject as NHC's "Tropical Depression Five".
 *
 * Only the storm feeds get this treatment. A wire story that merely mentions a
 * hurricane ("Karina forces Salina Cruz refinery shutdown") is not a product of
 * the advisory cycle — it is the one storm item that could justify an equity
 * trade, and collapsing it into the advisory would throw away the signal this
 * whole change exists to find.
 */
export function attentionKey(headline: string, sourceFamily?: string): AttentionKey | null {
  if (sourceFamily !== undefined && sourceFamily !== "disaster") return null;
  const h = headline.replace(/^summary for\s+/i, "");
  const m = new RegExp(`(?:^|\\b)(?:${DESIGNATION.source})\\s+([A-Za-z][A-Za-z0-9-]*)`, "i").exec(h);
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/-\d+$/, "");
  // "Outlook" is a basin-wide product, not a storm; "for" catches odd phrasings.
  if (name === "outlook" || name === "for" || name.length < 3) return null;
  const num = /\bnumber\s+(\d+[a-z]?)/i.exec(headline);
  const rank = PRODUCT_RANK.find(([re]) => re.test(headline))?.[1] ?? 2;
  return { subject: `storm:${name}`, cycle: num ? num[1].toLowerCase() : null, rank };
}

interface CycleState {
  bestRank: number;
  ms: number;
}

export class RecentActivity {
  private triagedHeadlines = new Map<string, number>(); // normalized headline -> last seen ms
  /** "storm:karina#26" -> the best product rank already triaged for that cycle. */
  private cycles = new Map<string, CycleState>();
  /** Which cycle a storm is currently in, so undated products join it. */
  private latestCycle = new Map<string, { cycle: string; ms: number }>();
  private investigations: (RecentInvestigation & { atMs: number })[] = [];
  /**
   * Holds that named a watch_symbol: the instruments the agent considered and
   * left. Read back as the mandate's watchlist (mandate.ts) so a "watch USDJPY"
   * is a candidate the next investigation and the daily review must dispose of,
   * not a note to nobody. In-memory like the rest of this class; a restart
   * forgets it, and the THESIS# rows keep the durable copy.
   */
  private watches: (WatchIdea & { atMs: number })[] = [];

  constructor(
    private dedupeMs = config.dedupeHours * 3_600_000,
    private historyMs = 6 * 3_600_000,
    private historyMax = 12,
  ) {}

  /**
   * True if this item adds nothing to something already triaged in the window:
   * an identical headline, or another product of a storm advisory cycle already
   * seen at the same or greater informativeness. Records the sighting.
   */
  isDuplicate(
    item: { headline: string; source_family?: string },
    nowMs = Date.now(),
  ): boolean {
    const { headline } = item;
    const a = attentionKey(headline, item.source_family);
    if (a) return this.isDuplicateCycle(a, nowMs);
    const key = normalizeHeadline(headline);
    const last = this.triagedHeadlines.get(key);
    this.triagedHeadlines.set(key, nowMs);
    if (this.triagedHeadlines.size > 2000) this.prune(nowMs);
    return last !== undefined && nowMs - last < this.dedupeMs;
  }

  private isDuplicateCycle(a: AttentionKey, nowMs: number): boolean {
    const known = this.latestCycle.get(a.subject);
    // An undated product (Graphics, Summary, surge map) belongs to whatever
    // cycle is current; the first one seen for an unknown storm starts cycle 0.
    const cycle =
      a.cycle ?? (known && nowMs - known.ms < this.dedupeMs ? known.cycle : "0");
    const key = `${a.subject}#${cycle}`;
    const seen = this.cycles.get(key);
    const dup = seen !== undefined && nowMs - seen.ms < this.dedupeMs && a.rank <= seen.bestRank;
    this.cycles.set(key, {
      bestRank: seen && nowMs - seen.ms < this.dedupeMs ? Math.max(seen.bestRank, a.rank) : a.rank,
      ms: nowMs,
    });
    if (a.cycle) this.latestCycle.set(a.subject, { cycle: a.cycle, ms: nowMs });
    if (this.cycles.size > 2000) this.prune(nowMs);
    return dup;
  }

  recordInvestigation(headline: string, decisions: TradeDecision[], nowMs = Date.now()): void {
    const outcome = decisions
      .map((d) =>
        d.action === "hold"
          ? `hold${d.watch_symbol ? ` (watch ${d.watch_symbol})` : ""}`
          : `${d.action} ${d.symbol} $${d.notional_usd}`,
      )
      .join("; ");
    this.investigations.push({
      at: new Date(nowMs).toISOString(),
      atMs: nowMs,
      headline: headline.slice(0, 120),
      outcome,
    });
    for (const d of decisions) {
      if (d.action === "hold" && d.watch_symbol) {
        this.watches.push({
          symbol: d.watch_symbol,
          at: new Date(nowMs).toISOString(),
          atMs: nowMs,
          headline: headline.slice(0, 120),
          rationale: d.rationale ?? "",
          confidence: d.confidence,
        });
      }
    }
    this.prune(nowMs);
  }

  /** Watched-and-untraded instruments in the mandate window, newest first, one entry per symbol. */
  watchlist(nowMs = Date.now(), windowMs = config.mandate.watchlistHours * 3_600_000): WatchIdea[] {
    const seen = new Set<string>();
    const out: WatchIdea[] = [];
    for (let i = this.watches.length - 1; i >= 0; i--) {
      const w = this.watches[i];
      if (nowMs - w.atMs > windowMs) break;
      if (seen.has(w.symbol)) continue;
      seen.add(w.symbol);
      const { atMs: _atMs, ...idea } = w;
      out.push(idea);
    }
    return out;
  }

  recent(nowMs = Date.now()): RecentInvestigation[] {
    this.prune(nowMs);
    return this.investigations
      .slice(-this.historyMax)
      .map(({ at, headline, outcome }) => ({ at, headline, outcome }));
  }

  private prune(nowMs: number): void {
    this.investigations = this.investigations.filter((i) => nowMs - i.atMs < this.historyMs);
    const watchMs = config.mandate.watchlistHours * 3_600_000;
    this.watches = this.watches.filter((w) => nowMs - w.atMs < watchMs);
    for (const [k, t] of this.triagedHeadlines) {
      if (nowMs - t >= this.dedupeMs) this.triagedHeadlines.delete(k);
    }
    for (const [k, s] of this.cycles) {
      if (nowMs - s.ms >= this.dedupeMs) this.cycles.delete(k);
    }
    for (const [k, s] of this.latestCycle) {
      if (nowMs - s.ms >= this.dedupeMs) this.latestCycle.delete(k);
    }
  }
}

/**
 * One process-wide instance. It is shared rather than owned by the news worker
 * because every adjudication belongs in the history triage sees, whatever
 * triggered it: a watch alert or the daily review re-underwrites a position
 * minutes before the next advisory arrives, and triage used to be blind to that
 * (recordInvestigation was called only from the news path).
 */
export const recentActivity = new RecentActivity();
