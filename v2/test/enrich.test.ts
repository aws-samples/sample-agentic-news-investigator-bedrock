// SPDX-License-Identifier: MIT-0
import { describe, it, expect, vi } from "vitest";
import {
  isFiling, clipForSummary, applyEnrichment, enrichForTriage, FILING_SUMMARY_MARKER, SUMMARY_INPUT_CHARS,
  type Enrichment,
} from "../src/enrich.js";
import type { NewsItem } from "../src/types.js";

const edgar = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: "nws_1",
  source_family: "edgar",
  source_id: "x",
  published_at: "2026-09-03T14:21:00.000Z",
  ingested_at: "2026-09-03T14:21:30.000Z",
  headline: "8-K - HORNBECK OFFSHORE SERVICES, INC. (0000866829) (Filer)",
  summary: "Item 1.01, Item 9.01. Accession 0000866829-26-000042. 51 KB.",
  url: "https://www.sec.gov/Archives/edgar/data/866829/000086682926000042/0000866829-26-000042-index.htm",
  body_s3_uri: null,
  tickers_hint: [],
  ...over,
});

const enrichment: Enrichment = {
  summary: "Entered a $250 million secured credit agreement with Wells Fargo maturing 2031. Routine financing disclosure.",
  items: ["1.01", "9.01"],
  tickers: ["hos"],
  source_ref: "0000866829-26-000042",
  model: "haiku",
};

describe("isFiling", () => {
  it("accepts 8-K and 8-K/A from the EDGAR family only", () => {
    expect(isFiling(edgar())).toBe(true);
    expect(isFiling(edgar({ headline: "8-K/A - ACME CORP (0001) (Filer)" }))).toBe(true);
    expect(isFiling(edgar({ headline: "10-Q - ACME CORP (0001) (Filer)" }))).toBe(false);
    expect(isFiling(edgar({ source_family: "macro", headline: "8-K style headline" }))).toBe(false);
  });
});

describe("clipForSummary", () => {
  it("normalises whitespace and keeps the head of a long filing", () => {
    const long = "COVER PAGE\n\n\n\nItem 1.01   \n" + "x".repeat(SUMMARY_INPUT_CHARS * 2);
    const out = clipForSummary(long);
    expect(out.startsWith("COVER PAGE\n\nItem 1.01\n")).toBe(true);
    expect(out.length).toBeLessThan(SUMMARY_INPUT_CHARS + 100);
    expect(out.endsWith("[... truncated for summary ...]")).toBe(true);
    expect(clipForSummary("short")).toBe("short");
  });
});

describe("applyEnrichment", () => {
  it("appends the filing summary with items, merges upper-cased tickers, leaves the input untouched", () => {
    const item = edgar({ tickers_hint: ["HOS"] });
    const out = applyEnrichment(item, enrichment);
    expect(out.summary).toContain(item.summary);
    expect(out.summary).toContain(`${FILING_SUMMARY_MARKER} Items: 1.01, 9.01.`);
    expect(out.summary).toContain("Wells Fargo");
    expect(out.tickers_hint).toEqual(["HOS"]);
    expect(out.enrichment).toBe(enrichment);
    expect(item.summary).not.toContain(FILING_SUMMARY_MARKER);
    expect(item.tickers_hint).toEqual(["HOS"]);
  });
  it("adds the cover-page ticker when the feed had none", () => {
    expect(applyEnrichment(edgar(), enrichment).tickers_hint).toEqual(["HOS"]);
  });
  it("makes the feed's entity-escaped line legible before appending", () => {
    const item = edgar({ summary: "\n &lt;b&gt;Filed:&lt;/b&gt; 2026-09-04 &lt;b&gt;AccNo:&lt;/b&gt; 0001-26-1\n&lt;br&gt;Item 1.01: Entry into a Material Definitive Agreement" });
    const out = applyEnrichment(item, enrichment);
    expect(out.summary.startsWith("Filed: 2026-09-04 AccNo: 0001-26-1")).toBe(true);
    expect(out.summary).not.toContain("&lt;");
    expect(out.summary).toContain("Item 1.01: Entry into a Material Definitive Agreement");
  });
});

describe("enrichForTriage", () => {
  const log = () => {};
  it("passes non-filings through without reading anything", async () => {
    const read = vi.fn();
    const item = edgar({ source_family: "macro", headline: "ISM beats" });
    expect(await enrichForTriage(item, { read, log })).toBe(item);
    expect(read).not.toHaveBeenCalled();
  });
  it("enriches a filing from the read text and the summarizer's answer", async () => {
    const read = vi.fn(async () => ({ source: "edgar" as const, ref: "acc-1", text: "COVER ... Item 1.01 ...", truncated: false }));
    const summarize = vi.fn(async (_text: string) => ({ summary: "Signed a $250M facility. Routine.", items: ["1.01"], tickers: ["HOS"] }));
    const out = await enrichForTriage(edgar(), { read, summarize, log });
    expect(read).toHaveBeenCalledWith({ url: edgar().url, body_s3_uri: null });
    expect(summarize.mock.calls[0]![0]).toBe("COVER ... Item 1.01 ...");
    expect(out.enrichment).toMatchObject({ summary: "Signed a $250M facility. Routine.", items: ["1.01"], tickers: ["HOS"], source_ref: "acc-1" });
    expect(out.tickers_hint).toEqual(["HOS"]);
    expect(out.summary).toContain(FILING_SUMMARY_MARKER);
  });
  it("returns the item unchanged when the source cannot be read", async () => {
    const item = edgar();
    const out = await enrichForTriage(item, { read: async () => ({ error: "EDGAR 404" }), summarize: vi.fn(), log });
    expect(out).toBe(item);
  });
  it("returns the item unchanged when the summarizer throws or answers empty", async () => {
    const item = edgar();
    const read = async () => ({ source: "edgar" as const, ref: "r", text: "t", truncated: false });
    expect(await enrichForTriage(item, { read, summarize: async () => { throw new Error("bedrock down"); }, log })).toBe(item);
    expect(await enrichForTriage(item, { read, summarize: async () => ({ summary: "", items: [], tickers: [] }), log })).toBe(item);
  });
  it("gives up at the deadline and triages the bare entry", async () => {
    const item = edgar();
    const never = () => new Promise<never>(() => {});
    const out = await enrichForTriage(item, { read: never as any, timeoutMs: 30, log });
    expect(out).toBe(item);
  });
});
