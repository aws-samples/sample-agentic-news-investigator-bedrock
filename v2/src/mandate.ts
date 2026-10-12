// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";

/**
 * The deployment mandate: what the book is FOR, printed into every
 * investigation's book context.
 *
 * Why (measured 2026-09-04 over Aug 31 – Sep 4, v2): 237 news-triggered
 * decisions, 6 buys — all prediction contracts, all before Sep 2 — and 231
 * holds at a mean confidence of 0.90 (207 of them at 0.8 or above). The
 * investigator was told "a lone hold is a first-class outcome ... saying so
 * crisply is a win" and "restraint gets credit too", saw only its cash figure
 * and its held positions, and behaved like an analyst: every event was either
 * priced in or not its book. The watch symbols on those holds — USDJPY seven
 * times, USDMXN seven, EURUSD four — were "a note to nobody" (the Sep 4 letter):
 * nothing ever read them back.
 *
 * This module turns the same facts into a mandate the agent can act on: how
 * much of equity is deployed against a target band, what conviction buys at
 * current equity, and the watchlist of instruments it already considered and
 * left on the table. The prompt (prompts.ts) carries the policy; this carries
 * the numbers. Both arms get it — the v2↔v3 comparison stays about the world
 * model. A paper book; the user asked for trades to be made.
 */

export interface BookPosition {
  symbol: string;
  qty: number;
  avg_cost: number;
  last_seen_price: number | null;
}

export interface BookSnapshot {
  cash_usd: number | null;
  positions: BookPosition[];
}

export interface Utilization {
  /** cash + signed marks; null when the ledger has no cash figure. */
  equityUsd: number | null;
  /** Gross exposure: sum of |qty × mark| across longs and shorts. */
  deployedUsd: number;
  deployedPct: number | null;
  positions: number;
}

export interface WatchIdea {
  symbol: string;
  at: string;
  headline: string;
  rationale: string;
  confidence: number;
}

/** Marks at the last watched price, falling back to cost for a position never watched. */
export function bookUtilization(book: BookSnapshot): Utilization {
  let signed = 0;
  let gross = 0;
  for (const p of book.positions) {
    const px = p.last_seen_price ?? p.avg_cost;
    signed += p.qty * px;
    gross += Math.abs(p.qty * px);
  }
  const equityUsd = book.cash_usd === null ? null : book.cash_usd + signed;
  const deployedPct = equityUsd !== null && equityUsd > 0 ? gross / equityUsd : null;
  return { equityUsd, deployedUsd: gross, deployedPct, positions: book.positions.length };
}

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The block appended to the book context. Numbers first, then the status
 * against the band, then the conviction ladder in dollars, then the watchlist.
 */
export function renderMandate(
  util: Utilization,
  watchlist: WatchIdea[],
  m: typeof config.mandate = config.mandate,
  now = new Date(),
): string {
  const lines: string[] = [];
  const eq = util.equityUsd;
  const deployed = util.deployedPct === null ? "unknown %" : pct(util.deployedPct);
  lines.push(
    `Mandate (deployment): equity ${eq === null ? "unknown" : usd(eq)}; deployed ${usd(util.deployedUsd)} ` +
      `(${deployed}) in ${util.positions} position${util.positions === 1 ? "" : "s"}. ` +
      `Target ${pct(m.minDeployedPct)}–${pct(m.maxDeployedPct)} of equity deployed across ` +
      `${m.minPositions}–${m.maxPositions} positions; no single position above ${pct(m.maxPositionPct)} of equity.`,
  );
  if (eq !== null && util.deployedPct !== null) {
    if (util.deployedPct < m.minDeployedPct) {
      const gap = m.minDeployedPct * eq - util.deployedUsd;
      lines.push(
        `Status: UNDER-DEPLOYED — ${usd(gap)} short of the ${pct(m.minDeployedPct)} floor. ` +
          `Cash is not a position; it is an unexpressed view. This event, and every candidate on the ` +
          `watchlist below, is an opportunity to close that gap — or to say precisely why not.`,
      );
    } else if (util.deployedPct > m.maxDeployedPct) {
      lines.push(
        `Status: ABOVE the ${pct(m.maxDeployedPct)} ceiling — prefer rotations and exits over new gross.`,
      );
    } else {
      lines.push(`Status: within the mandate.`);
    }
    lines.push(
      `Conviction → size at current equity: 0.55 ≈ 1% (${usd(eq * 0.01)}), ` +
        `0.60–0.65 ≈ 2–3% (${usd(eq * 0.02)}–${usd(eq * 0.03)}), ` +
        `0.70+ ≈ 4–6% (${usd(eq * 0.04)}–${usd(eq * 0.06)}), cap ${pct(m.maxPositionPct)} (${usd(eq * m.maxPositionPct)}).`,
    );
  }
  if (watchlist.length === 0) {
    lines.push(`Watchlist: empty — nothing considered and left untraded in the last ${m.watchlistHours}h.`);
  } else {
    lines.push(
      `Watchlist — instruments this book considered in the last ${m.watchlistHours}h and did not trade. ` +
        `Each is a live candidate in either direction until you rule it out:`,
    );
    for (const w of watchlist) {
      const ageH = Math.max(0, Math.round((now.getTime() - Date.parse(w.at)) / 3_600_000));
      lines.push(
        `- ${w.symbol} (${ageH}h ago, hold conf ${w.confidence.toFixed(2)}, on "${w.headline.slice(0, 70)}"): ` +
          `${w.rationale.slice(0, 220).replace(/\s+/g, " ")}`,
      );
    }
  }
  return lines.join("\n");
}
