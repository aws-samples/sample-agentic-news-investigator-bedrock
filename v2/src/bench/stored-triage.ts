// SPDX-License-Identifier: MIT-0
import { applyEnrichment } from "../enrich.js";
import type { TriageVerdict } from "../triage.js";
import type { NewsItem } from "../types.js";

/**
 * Re-use another bench run's triage (`replay.ts --triage-from <bench>`): the
 * `bench-triage` audit row holds the verdict and, for a filing, the summary
 * the enrichment step appended. Rebuilding from it gives a new run the same
 * events with the same text and verdicts, so two runs differ only in what
 * they vary (e.g. the model), without paying for triage twice.
 *
 * Rows written before 2026-10-14 lack `filing_tickers` (the cover-page
 * symbols enrichment merges into tickers_hint); for those the item keeps the
 * poller's own tickers_hint. Pure.
 */
export interface StoredTriage {
  materiality: number;
  event_type?: string;
  regions?: string[];
  touches_positions?: boolean;
  hypotheses?: string[];
  rationale?: string;
  filing_summary?: string;
  filing_items?: string[];
  filing_tickers?: string[];
}

export function fromStoredTriage(
  raw: NewsItem,
  row: StoredTriage,
  sourceBench: string,
): { item: NewsItem; verdict: TriageVerdict } {
  const item = row.filing_summary
    ? applyEnrichment(raw, {
        summary: row.filing_summary,
        items: row.filing_items ?? [],
        tickers: row.filing_tickers ?? [],
        source_ref: `bench-triage:${sourceBench}`,
        model: "stored",
      })
    : raw;
  const verdict: TriageVerdict = {
    materiality: Number(row.materiality),
    event_type: row.event_type ?? "",
    regions: row.regions ?? [],
    touches_positions: row.touches_positions ?? false,
    hypotheses: row.hypotheses ?? [],
    rationale: row.rationale ?? "",
  };
  return { item, verdict };
}
