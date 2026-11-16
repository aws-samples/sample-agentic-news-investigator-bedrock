// SPDX-License-Identifier: MIT-0
/**
 * Storm advisory cycles, triaged by their most informative product (V2_STORM_HOLD_SECS).
 *
 * NHC sends one advisory cycle as five to seven products within a minute or two, and the
 * dedupe in recent.ts lets one product stand for the cycle. Which one depended on queue order:
 * on Hurricane Vance cycle 11 (2026-10-24 02:46) v5's worker drew the Summary — 235 characters
 * of plain English — and scored 0.72; v6 drew the Forecast Advisory — 2,290 characters of coded
 * TCM text — and scored 0.05, then dropped the Summary as a duplicate. With a hold window the
 * worker keeps a cycle's products for a few seconds and triages the best one, so every arm reads
 * the same product. The products not chosen get the usual v2-dedupe row.
 *
 * Pure (no I/O): the worker offers each storm item and asks for the cycles whose window closed.
 * Held items live in memory: a restart inside the window loses that cycle (the next advisory
 * comes within hours).
 */
import { attentionKey } from "./recent.js";
import type { NewsItem } from "./types.js";

/** How much a product tells triage, in prose it can read. Higher is better. */
const TRIAGE_RANK: [RegExp, number][] = [
  [/\bforecast discussion\b/i, 5], // the intensity and track reasoning category contracts hinge on
  [/\bpublic advisory\b/i, 4], // plain-English position, intensity, watches and warnings
  [/\b(tropical cyclone )?update\b/i, 4],
  [/^summary for\b/i, 3], // two plain sentences
  [/\bforecast advisory\b/i, 2], // coded TCM text
];

export function triageRank(headline: string): number {
  return TRIAGE_RANK.find(([re]) => re.test(headline))?.[1] ?? 1; // graphics, maps, wind probabilities
}

interface Held {
  best: NewsItem;
  rank: number;
  dueMs: number;
  passedOver: NewsItem[];
}

export type Offer = "pass" | "held";

export class StormCycleBuffer {
  private held = new Map<string, Held>();
  constructor(private holdMs: number) {}

  /** "pass": not a storm product (or holding is off) — triage it now. "held": kept until its cycle's window closes. */
  offer(item: NewsItem, nowMs: number): Offer {
    if (this.holdMs <= 0) return "pass";
    const a = attentionKey(item.headline, item.source_family);
    if (!a) return "pass";
    // Undated products (Summary, Graphics) join whichever cycle of that storm is being held.
    const key = a.cycle ? `${a.subject}#${a.cycle}` : this.openCycleOf(a.subject) ?? `${a.subject}#?`;
    // An undated product that arrived first opened "<storm>#?": the first numbered product names that cycle.
    const undated = this.held.get(`${a.subject}#?`);
    if (a.cycle && undated && !this.held.has(key)) {
      this.held.delete(`${a.subject}#?`);
      this.held.set(key, undated);
    }
    const rank = triageRank(item.headline);
    const h = this.held.get(key);
    if (!h) {
      this.held.set(key, { best: item, rank, dueMs: nowMs + this.holdMs, passedOver: [] });
    } else if (rank > h.rank) {
      h.passedOver.push(h.best);
      h.best = item;
      h.rank = rank;
    } else {
      h.passedOver.push(item);
    }
    return "held";
  }

  /** Cycles whose window has closed: the product to triage, and the ones it was chosen over. */
  due(nowMs: number): { best: NewsItem; passedOver: NewsItem[] }[] {
    const out: { best: NewsItem; passedOver: NewsItem[] }[] = [];
    for (const [key, h] of this.held) {
      if (nowMs >= h.dueMs) {
        out.push({ best: h.best, passedOver: h.passedOver });
        this.held.delete(key);
      }
    }
    return out;
  }

  private openCycleOf(subject: string): string | undefined {
    for (const key of this.held.keys()) if (key.startsWith(`${subject}#`)) return key;
    return undefined;
  }
}
