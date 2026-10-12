// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  daysBetween,
  easternToUtcIso,
  edgarItem,
  filingHeaderUrl,
  formIndexUrl,
  parseFilingHeader,
  parseFormIndex,
  pickFilings,
  tickerMap,
  usgsItem,
  usgsItems,
} from "../src/bench/public-corpus.js";
import { edgarRef } from "../src/source.js";
import { parseCorpus, serializeCorpus } from "../src/bench/corpus.js";

// Format-only fixtures: the layout of EDGAR's daily index and filing headers and
// of a USGS GeoJSON feature, with placeholder names. No real records.
const INDEX = [
  "Description:           Daily Index of EDGAR Dissemination Feed by Form Type",
  "Form Type   Company Name                                                  CIK",
  "      Date Filed  File Name",
  "---------------------------------------------------------------------------------------------",
  "1-U              EXAMPLE FUND LLC                                              3     20260901    edgar/data/3/0000000003-26-000001.txt        ",
  "8-K              EXAMPLE CORP                                                  1     20260901    edgar/data/1/0000000001-26-000002.txt        ",
  "8-K/A            Another Example Co, Inc.                                      2     20260901    edgar/data/2/0000000002-26-000003.txt        ",
  "8-K              UNLISTED EXAMPLE LP                                           4     20260901    edgar/data/4/0000000004-26-000004.txt        ",
].join("\n");

const HEADER = [
  "<html><body><pre>",
  "&lt;ACCEPTANCE-DATETIME&gt;20260901161340",
  "CONFORMED SUBMISSION TYPE:\t8-K",
  "ITEM INFORMATION:\t\tResults of Operations and Financial Condition",
  "ITEM INFORMATION:\t\tFinancial Statements and Exhibits",
  "ITEM INFORMATION:\t\tSomething EDGAR added later",
  "</pre></body></html>",
].join("\n");

describe("EDGAR daily index", () => {
  it("parses fixed-width rows, keeping multi-word company names", () => {
    const rows = parseFormIndex(INDEX);
    expect(rows.map((r) => [r.form, r.company, r.cik, r.accession])).toEqual([
      ["1-U", "EXAMPLE FUND LLC", 3, "0000000003-26-000001"],
      ["8-K", "EXAMPLE CORP", 1, "0000000001-26-000002"],
      ["8-K/A", "Another Example Co, Inc.", 2, "0000000002-26-000003"],
      ["8-K", "UNLISTED EXAMPLE LP", 4, "0000000004-26-000004"],
    ]);
  });

  it("keeps listed filers' 8-Ks and amendments, capped per day, in accession order", () => {
    const tickers = tickerMap({ 0: { cik_str: 1, ticker: "EXA" }, 1: { cik_str: 2, ticker: "EXB" }, 2: { cik_str: 2, ticker: "EXB2" } });
    expect(tickers.get(2)).toBe("EXB"); // first listed ticker wins
    const rows = parseFormIndex(INDEX);
    expect(pickFilings(rows, tickers, 10).map((r) => r.cik)).toEqual([1, 2]);
    expect(pickFilings(rows, tickers, 1).map((r) => r.cik)).toEqual([1]);
  });

  it("builds the quarter's index URL and the filing header URL", () => {
    expect(formIndexUrl("2026-09-01")).toBe("https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260901.idx");
    expect(formIndexUrl("2026-01-02")).toContain("/2026/QTR1/form.20260102.idx");
    const [row] = parseFormIndex(INDEX).filter((r) => r.cik === 1);
    expect(filingHeaderUrl(row)).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/0000000001-26-000002-index-headers.html",
    );
  });
});

describe("filing header", () => {
  it("reads acceptance time (Eastern -> UTC) and maps item names to numbers", () => {
    const h = parseFilingHeader(HEADER)!;
    expect(h.acceptedAt).toBe("2026-09-01T20:13:40.000Z"); // EDT, UTC-4
    expect(h.items).toEqual([
      "Item 2.02: Results of Operations and Financial Condition",
      "Item 9.01: Financial Statements and Exhibits",
      "Something EDGAR added later",
    ]);
  });

  it("handles standard time and rejects a header without an acceptance time", () => {
    expect(easternToUtcIso("20260115093000")).toBe("2026-01-15T14:30:00.000Z"); // EST, UTC-5
    expect(parseFilingHeader("<pre>nothing here</pre>")).toBeNull();
  });

  it("produces the live poller's item shape, resolvable by read_source", () => {
    const [row] = parseFormIndex(INDEX).filter((r) => r.cik === 1);
    const item = edgarItem(row, parseFilingHeader(HEADER)!, "EXA");
    expect(item).toMatchObject({
      id: "edgar-0000000001-26-000002",
      source_family: "edgar",
      headline: "8-K - EXAMPLE CORP (0000000001) (Filer)",
      tickers_hint: ["EXA"],
      published_at: "2026-09-01T20:13:40.000Z",
    });
    expect(item.summary).toContain("AccNo: 0000000001-26-000002");
    expect(item.summary).toContain("Item 2.02: Results of Operations");
    expect(edgarRef(item.url)?.accession).toBe("0000000001-26-000002");
  });
});

describe("USGS", () => {
  const feature = (mag: number, extra: Record<string, unknown> = {}) => ({
    id: "xx0001",
    properties: { mag, place: "10 km N of Example", time: Date.UTC(2026, 8, 1, 3, 14, 22, 310), url: "https://example.invalid/e", tsunami: 1, ...extra },
  });

  it("matches the poller's headline and summary", () => {
    const item = usgsItem(feature(6.04))!;
    expect(item.headline).toBe("EARTHQUAKE: M6.0 10 km N of Example");
    expect(item.summary).toBe(
      "USGS reports a magnitude 6.0 earthquake, 10 km N of Example. Tsunami flag: true. " +
        "Detected at 2026-09-01 03:14:22.310 UTC. Details: https://example.invalid/e",
    );
    expect(item).toMatchObject({ id: "usgs-xx0001", source_family: "disaster", source_id: "xx0001", tickers_hint: [] });
  });

  it("drops quakes below the poller's bar and malformed features", () => {
    expect(usgsItem(feature(5.4))).toBeNull();
    expect(usgsItems({ features: [feature(5.5), feature(4.9), { id: 1 }] })).toHaveLength(1);
  });
});

describe("corpus round trip", () => {
  it("serializes a built corpus with source=public and parses it back", () => {
    const items = [usgsItem({ id: "a", properties: { mag: 6, place: "p", time: 0, url: "" } })!];
    const { text } = serializeCorpus(items, { source: "public", createdAt: "2026-10-09T00:00:00.000Z" });
    expect(parseCorpus(text).header.source).toBe("public");
  });
});

describe("daysBetween", () => {
  it("lists days inclusively and bounds the span", () => {
    expect(daysBetween("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
    expect(() => daysBetween("2026-09-02", "2026-09-01")).toThrow();
    expect(() => daysBetween("2026-01-01", "2026-03-01")).toThrow(/at most 31/);
    expect(() => daysBetween("2026/01/01", "2026-01-02")).toThrow();
  });
});
