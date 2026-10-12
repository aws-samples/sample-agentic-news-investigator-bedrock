// SPDX-License-Identifier: MIT-0
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorpusError,
  canonicalLine,
  corpusHash,
  formatSidecar,
  isPublicDomainItem,
  itemsHash,
  orderItems,
  parseCorpus,
  publicDomainItems,
  readCorpus,
  readSidecarHash,
  selectEvents,
  serializeCorpus,
  sha256Hex,
  toBenchEvent,
  windowOf,
  wireItem,
  writeCorpus,
} from "../src/bench/corpus.js";
import type { NewsItem } from "../src/types.js";

// No AWS, no Bedrock: corpus.ts touches only the files named in its function names.

function news(id: string, published_at: string, extra: Partial<NewsItem> = {}): NewsItem {
  return {
    id,
    source_family: "disaster",
    source_id: `src-${id}`,
    published_at,
    ingested_at: published_at,
    headline: `headline ${id}`,
    summary: `summary ${id}`,
    url: `https://sample.invalid/${id}`,
    tickers_hint: [],
    ...extra,
  };
}

const A = news("a", "2026-08-17T03:14:22.310Z");
const B = news("b", "2026-08-18T09:02:00Z", { body_s3_uri: null, asset_class_hint: null });
const C = news("c", "2026-08-18T09:02:00Z", {
  source_family: "edgar",
  tickers_hint: ["QZRX"],
  asset_class_hint: "equity",
  // Never on the wire; the bench recomputes it.
  enrichment: { summary: "x", items: ["2.02"], tickers: ["QZRX"], source_ref: "r", model: "m" },
});
const D = news("d", "2026-08-20T01:55:00Z", { body_s3_uri: "s3://bucket/2026/08/20/d.txt" });
const SHUFFLED = [D, C, A, B];
const CREATED = "2026-09-11T00:00:00.000Z";

describe("canonical form", () => {
  it("orders by published_at, then id; does not mutate", () => {
    const input = [...SHUFFLED];
    expect(orderItems(input).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(input.map((i) => i.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("wireItem drops enrichment and nulls and sorts keys", () => {
    const w = wireItem(C) as unknown as Record<string, unknown>;
    expect(Object.keys(w)).toEqual([...Object.keys(w)].sort());
    expect("enrichment" in w).toBe(false);
    expect(wireItem(B)).not.toHaveProperty("body_s3_uri");
    expect(wireItem(B)).not.toHaveProperty("asset_class_hint");
    expect(wireItem(D).body_s3_uri).toBe("s3://bucket/2026/08/20/d.txt");
  });

  it("canonicalLine is a single compact JSON line", () => {
    const line = canonicalLine(C);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ id: "c", tickers_hint: ["QZRX"], asset_class_hint: "equity" });
    expect(line.startsWith('{"asset_class_hint":"equity","headline":')).toBe(true);
  });

  it("itemsHash ignores input order and the header", () => {
    expect(itemsHash(SHUFFLED)).toBe(itemsHash([A, B, C, D]));
    expect(itemsHash([A, B])).not.toBe(itemsHash([A, B, C]));
    expect(itemsHash([])).toBe(sha256Hex("\n"));
  });

  it("windowOf spans the earliest and latest published_at", () => {
    expect(windowOf(SHUFFLED)).toEqual({ start: "2026-08-17T03:14:22.310Z", end: "2026-08-20T01:55:00.000Z" });
    expect(windowOf([])).toBeNull();
  });
});

describe("serialize / parse", () => {
  it("header first, then ordered canonical lines, trailing newline; parses back to the same items", () => {
    const { text, header } = serializeCorpus(SHUFFLED, { source: "sample", createdAt: CREATED, note: "n" });
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    expect(JSON.parse(lines[0])).toEqual({
      fin_corpus: 1,
      created_at: CREATED,
      source: "sample",
      window: { start: "2026-08-17T03:14:22.310Z", end: "2026-08-20T01:55:00.000Z" },
      count: 4,
      note: "n",
    });
    expect(lines.slice(1, 5).map((l) => JSON.parse(l).id)).toEqual(["a", "b", "c", "d"]);
    expect(header.count).toBe(4);

    const parsed = parseCorpus(text);
    expect(parsed.header).toEqual(header);
    expect(parsed.items).toEqual([A, B, C, D].map(wireItem));
    expect(parsed.items[2]).not.toHaveProperty("enrichment");
  });

  it("an explicit window is recorded verbatim", () => {
    const { header } = serializeCorpus([A], { source: "archive", createdAt: CREATED, window: { start: "2026-08-17T00:00:00.000Z", end: "2026-08-24T00:00:00.000Z" } });
    expect(header.window).toEqual({ start: "2026-08-17T00:00:00.000Z", end: "2026-08-24T00:00:00.000Z" });
  });

  it("tolerates blank lines and a missing count", () => {
    const text = `\n{"fin_corpus":1,"created_at":"${CREATED}","source":"archive","window":{"start":"","end":""}}\n\n${canonicalLine(A)}\n\n`;
    const c = parseCorpus(text);
    expect(c.items.map((i) => i.id)).toEqual(["a"]);
    expect(c.header.count).toBe(1);
  });

  const header = `{"fin_corpus":1,"created_at":"${CREATED}","source":"sample","window":{"start":"","end":""}}`;

  it.each<[string, string, RegExp]>([
    ["empty file", "\n\n", /empty file/],
    ["header not JSON", "not json\n", /line 1: header is not JSON/],
    ["header missing fields", `{"created_at":"${CREATED}"}\n`, /line 1: bad header: fin_corpus/],
    ["unknown source", `{"fin_corpus":1,"created_at":"${CREATED}","source":"web","window":{"start":"","end":""}}\n`, /bad header: source/],
    ["unsupported format", `{"fin_corpus":2,"created_at":"${CREATED}","source":"sample","window":{"start":"","end":""}}\n`, /unsupported corpus format 2/],
    ["item not JSON", `${header}\n{oops\n`, /line 2: item is not JSON/],
    ["item missing tickers_hint", `${header}\n${JSON.stringify({ ...wireItem(A), tickers_hint: undefined })}\n`, /line 2: bad item: tickers_hint/],
    ["item with a non-string ticker", `${header}\n${JSON.stringify({ ...wireItem(A), tickers_hint: [1] })}\n`, /line 2: bad item: tickers_hint\.0/],
    ["empty id", `${header}\n${JSON.stringify({ ...wireItem(A), id: "" })}\n`, /line 2: item has an empty id/],
    ["bad published_at", `${header}\n${JSON.stringify({ ...wireItem(A), published_at: "yesterday" })}\n`, /line 2: published_at is not a parseable time/],
    ["duplicate id", `${header}\n${canonicalLine(A)}\n${canonicalLine(A)}\n`, /line 3: duplicate item id a/],
    ["count mismatch", `${header.replace("}}", "},\"count\":3}")}\n${canonicalLine(A)}\n`, /count=3 but the file has 1/],
  ])("rejects %s with a line-numbered CorpusError", (_name, text, re) => {
    expect(() => parseCorpus(text)).toThrow(CorpusError);
    expect(() => parseCorpus(text)).toThrow(re);
  });

  it("serialize refuses duplicate ids and unparseable times", () => {
    expect(() => serializeCorpus([A, A], { source: "sample" })).toThrow(/duplicate item id a/);
    expect(() => serializeCorpus([news("z", "not a time")], { source: "sample" })).toThrow(/published_at of z/);
  });
});

describe("files: write, read, hash, sidecar", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fin-corpus-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips through disk; the sidecar and corpusHash agree with the write result", async () => {
    const path = join(dir, "nested", "week.jsonl");
    const w = await writeCorpus(path, SHUFFLED, { source: "archive", createdAt: CREATED });
    expect(w.count).toBe(4);
    expect(w.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.itemsHash).toBe(itemsHash(SHUFFLED));

    const back = await readCorpus(path);
    expect(back.items.map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(back.header.source).toBe("archive");

    expect(await corpusHash(path)).toBe(w.hash);
    expect(await readFile(`${path}.sha256`, "utf8")).toBe(formatSidecar(w.hash, path));
    expect(await readFile(`${path}.sha256`, "utf8")).toBe(`${w.hash}  week.jsonl\n`);
    expect(await readSidecarHash(path)).toBe(w.hash);
  });

  it("is deterministic: same items in any order + same createdAt -> identical bytes; a new createdAt changes the file hash but not the items hash", async () => {
    const p1 = join(dir, "one.jsonl");
    const p2 = join(dir, "two.jsonl");
    const p3 = join(dir, "three.jsonl");
    const w1 = await writeCorpus(p1, [A, B, C, D], { source: "sample", createdAt: CREATED });
    const w2 = await writeCorpus(p2, [D, C, B, A], { source: "sample", createdAt: CREATED });
    const w3 = await writeCorpus(p3, [D, C, B, A], { source: "sample", createdAt: "2026-09-12T00:00:00.000Z" });
    expect(await readFile(p1, "utf8")).toBe(await readFile(p2, "utf8"));
    expect(w1.hash).toBe(w2.hash);
    expect(w3.hash).not.toBe(w1.hash);
    expect(w3.itemsHash).toBe(w1.itemsHash);
  });

  it("detects a file edited after its sidecar was written", async () => {
    const path = join(dir, "edited.jsonl");
    const w = await writeCorpus(path, [A], { source: "sample", createdAt: CREATED });
    await writeFile(path, (await readFile(path, "utf8")) + canonicalLine(B) + "\n");
    expect(await corpusHash(path)).not.toBe(w.hash);
    expect(await readSidecarHash(path)).toBe(w.hash);
    // and the header's count now disagrees with the body
    await expect(readCorpus(path)).rejects.toThrow(/count=1 but the file has 2/);
  });

  it("readSidecarHash is null when there is no sidecar", async () => {
    expect(await readSidecarHash(join(dir, "nope.jsonl"))).toBeNull();
  });

  it("readCorpus surfaces CorpusError from a bad file", async () => {
    const path = join(dir, "bad.jsonl");
    await writeFile(path, "{}\n");
    await expect(readCorpus(path)).rejects.toBeInstanceOf(CorpusError);
  });
});

describe("selection and mapping", () => {
  it("selectEvents orders, clips to [start, end) and caps chronologically", () => {
    expect(selectEvents(SHUFFLED).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(selectEvents(SHUFFLED, { maxEvents: 2 }).map((i) => i.id)).toEqual(["a", "b"]);
    expect(selectEvents(SHUFFLED, { maxEvents: 0 })).toEqual([]);
    expect(selectEvents(SHUFFLED, { start: "2026-08-18T00:00:00Z", end: "2026-08-20T01:55:00Z" }).map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("toBenchEvent applies the threshold under test and normalises the verdict", () => {
    const ev = toBenchEvent(A, { materiality: 0.62, hypotheses: ["h1", 2 as unknown as string] }, 0.45);
    expect(ev).toEqual({ item: A, hypotheses: ["h1", "2"], materiality: 0.62, passed: true });
    expect(toBenchEvent(A, { materiality: 0.44, hypotheses: [] }, 0.45).passed).toBe(false);
    expect(toBenchEvent(A, { materiality: 0.45, hypotheses: [] }, 0.45).passed).toBe(true);
    const nan = toBenchEvent(A, { materiality: NaN, hypotheses: undefined as unknown as string[] }, 0.45);
    expect(nan).toMatchObject({ materiality: 0, passed: false, hypotheses: [] });
  });
});

describe("public-domain filter", () => {
  const edgar = news("e", "2026-08-17T12:00:00Z", { source_family: "edgar", headline: "8-K - GREY HERON MINERALS CORP (0009900109) (Filer)" });
  const usgs = news("u", "2026-08-17T12:00:00Z", { source_family: "disaster", headline: "EARTHQUAKE: M6.1 78 km E of Kushiro, Japan" });
  const nhc = news("n", "2026-08-17T12:00:00Z", { source_family: "disaster", headline: "Hurricane Ondine Public Advisory Number 9" });
  const prwire = news("p", "2026-08-17T12:00:00Z", { source_family: "prwire", headline: "Acme Announces Record Quarter" });
  const crypto = news("k", "2026-08-17T12:00:00Z", { source_family: "crypto", headline: "Bitcoin ETF inflows hit a record" });
  const macro = news("m", "2026-08-17T12:00:00Z", { source_family: "macro", headline: "ISM manufacturing beats" });

  it("keeps edgar and disaster items only", () => {
    expect(publicDomainItems([edgar, usgs, nhc, prwire, crypto, macro]).map((i) => i.id)).toEqual(["e", "u", "n"]);
  });

  it("strips anything that reads as wire-service or crypto-press copy even inside an allowed family", () => {
    expect(isPublicDomainItem({ ...edgar, headline: "8-K - ACME (PRNewswire) (Filer)" })).toBe(false);
    expect(isPublicDomainItem({ ...usgs, summary: "Via Reuters: a quake struck" })).toBe(false);
    expect(isPublicDomainItem({ ...nhc, url: "https://www.businesswire.com/news/home/1" })).toBe(false);
    expect(isPublicDomainItem({ ...nhc, url: "https://feeds.coindesk.com/x" })).toBe(false);
    expect(isPublicDomainItem({ ...nhc, url: "not a url" })).toBe(true);
  });
});
