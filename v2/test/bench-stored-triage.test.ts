// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { fromStoredTriage } from "../src/bench/stored-triage.js";
import { applyEnrichment } from "../src/enrich.js";
import type { NewsItem } from "../src/types.js";

const filing: NewsItem = {
  id: "n1",
  source_family: "edgar",
  source_id: "urn:x",
  published_at: "2026-09-10T14:00:00Z",
  ingested_at: "2026-09-10T14:00:05Z",
  headline: "8-K - EXAMPLE CORP (0000000001) (Filer)",
  summary: "Filed: 2026-09-10 AccNo: 0000000001-26-000001",
  url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/0000000001-26-000001-index.htm",
  tickers_hint: ["EXA"],
};

describe("fromStoredTriage", () => {
  it("rebuilds the enriched filing text exactly as enrichment would", () => {
    const row = { materiality: 0.7, hypotheses: ["EXA up"], filing_summary: "Example raised guidance.", filing_items: ["2.02"], filing_tickers: ["exb"] };
    const { item, verdict } = fromStoredTriage(filing, row, "src");
    const expected = applyEnrichment(filing, { summary: "Example raised guidance.", items: ["2.02"], tickers: ["exb"], source_ref: "x", model: "y" } as any);
    expect(item.summary).toBe(expected.summary);
    expect(item.tickers_hint).toEqual(["EXA", "EXB"]);
    expect(verdict).toMatchObject({ materiality: 0.7, hypotheses: ["EXA up"], touches_positions: false });
  });

  it("keeps the poller's tickers when the row predates filing_tickers", () => {
    const { item } = fromStoredTriage(filing, { materiality: 0.5, filing_summary: "s", filing_items: [] }, "src");
    expect(item.tickers_hint).toEqual(["EXA"]);
  });

  it("leaves a non-filing item untouched", () => {
    const quake = { ...filing, id: "q", source_family: "disaster", headline: "EARTHQUAKE: M6.0 x", summary: "USGS…" };
    const { item, verdict } = fromStoredTriage(quake, { materiality: 0.3 }, "src");
    expect(item).toBe(quake);
    expect(verdict.materiality).toBe(0.3);
  });
});
