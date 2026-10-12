// SPDX-License-Identifier: MIT-0
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { NewsItem } from "../types.js";
import type { TriageVerdict } from "../triage.js";
import type { BenchEvent } from "./run.js";

/**
 * A bench CORPUS is a JSONL file: one header line, then one wire-shape NewsItem
 * per line, in deterministic order (published_at, then id). It is what the
 * replay bench consumes instead of an EventBridge replay, so that
 *
 *  - two runs can be compared knowing they saw IDENTICAL inputs: the file's
 *    sha256 is recorded on every BENCHSUM row and the per-event diff refuses
 *    runs on different corpora;
 *  - a bench needs no shared replay queue or rule, so any number of runs can go
 *    at once (the archive front door in replay.ts serialises on one rule);
 *  - a corpus is never shipped with the repository (no dataset is distributed):
 *    build one from public sources (`bench:build`, public-corpus.ts) or dump one
 *    from your own deployment's archive (`bench:dump`).
 *
 * Two hashes, on purpose. `corpusHash(path)` is the sha256 of the file bytes —
 * the reproducibility key a user quotes. `itemsHash(items)` is the sha256 of
 * the canonical item lines alone (no header, so no created_at), which the
 * archive mode can also compute for what it drained: an archive run and a
 * corpus dumped from the same window share it, so they can be diffed.
 *
 * This module is pure apart from the file reads/writes named in the function
 * names: no AWS clients, no Bedrock. Import-safe from tests.
 */

export const CORPUS_FORMAT = 1;

export type CorpusSource = "archive" | "sample" | "public";

export interface CorpusHeader {
  fin_corpus: typeof CORPUS_FORMAT;
  created_at: string;
  /**
   * "archive": dumped from an EventBridge archive; "sample": synthesised or curated by hand;
   * "public": built from public historical sources by `bench:build` (public-corpus.ts).
   */
  source: CorpusSource;
  window: { start: string; end: string };
  /** Item lines that follow the header. */
  count: number;
  note?: string;
}

export interface Corpus {
  header: CorpusHeader;
  items: NewsItem[];
}

export class CorpusError extends Error {
  constructor(
    message: string,
    /** 1-based line in the file, when the problem is on one line. */
    public readonly line?: number,
  ) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "CorpusError";
  }
}

// Plain zod only (see docs/ARCHITECTURE.md on tool schemas; the same discipline keeps this
// file trivially portable). Unknown keys are dropped: the TypeScript NewsItem is
// the contract, and `enrichment` in particular is never on the wire — the bench
// recomputes it, exactly as the worker does.
const headerSchema = z.object({
  fin_corpus: z.number(),
  created_at: z.string(),
  source: z.enum(["archive", "sample", "public"]),
  window: z.object({ start: z.string(), end: z.string() }),
  count: z.number().optional(),
  note: z.string().optional(),
});

const newsItemSchema = z.object({
  id: z.string(),
  source_family: z.string(),
  source_id: z.string(),
  published_at: z.string(),
  ingested_at: z.string(),
  headline: z.string(),
  summary: z.string(),
  url: z.string(),
  body_s3_uri: z.string().nullable().optional(),
  tickers_hint: z.array(z.string()),
  asset_class_hint: z.string().nullable().optional(),
});

function isoOrThrow(value: string, what: string, line?: number): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new CorpusError(`${what} is not a parseable time: ${JSON.stringify(value)}`, line);
  return ms;
}

function zodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------

/** The wire shape: NewsItem fields only, no enrichment, no nulls, keys sorted. */
export function wireItem(item: NewsItem): NewsItem {
  const parsed = newsItemSchema.parse(item);
  const entries = Object.entries(parsed)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries) as unknown as NewsItem;
}

/** One item as its canonical JSONL line (sorted keys, no whitespace, no trailing newline). */
export function canonicalLine(item: NewsItem): string {
  return JSON.stringify(wireItem(item));
}

/** Deterministic order: published_at ascending, then the string itself, then id. Stable; does not mutate. */
export function orderItems(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.published_at);
    const tb = Date.parse(b.published_at);
    if (ta !== tb) return ta - tb;
    if (a.published_at !== b.published_at) return a.published_at < b.published_at ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of the canonical item lines (ordered, one per line, trailing newline). Header-independent. */
export function itemsHash(items: NewsItem[]): string {
  return sha256Hex(orderItems(items).map(canonicalLine).join("\n") + "\n");
}

/** Earliest and latest published_at among the items, or null when there are none. */
export function windowOf(items: NewsItem[]): { start: string; end: string } | null {
  if (items.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const it of items) {
    const ms = Date.parse(it.published_at);
    if (!Number.isFinite(ms)) continue;
    if (ms < lo) lo = ms;
    if (ms > hi) hi = ms;
  }
  if (!Number.isFinite(lo)) return null;
  return { start: new Date(lo).toISOString(), end: new Date(hi).toISOString() };
}

export interface SerializeOptions {
  source: CorpusSource;
  window?: { start: string; end: string };
  createdAt?: string;
  note?: string;
}

/** The whole file as text: header line, then ordered canonical item lines, trailing newline. */
export function serializeCorpus(items: NewsItem[], opts: SerializeOptions): { text: string; header: CorpusHeader } {
  const ordered = orderItems(items);
  const ids = new Set<string>();
  for (const it of ordered) {
    if (!it.id) throw new CorpusError("item without an id");
    if (ids.has(it.id)) throw new CorpusError(`duplicate item id ${it.id}`);
    ids.add(it.id);
    isoOrThrow(it.published_at, `published_at of ${it.id}`);
  }
  const window = opts.window ?? windowOf(ordered) ?? { start: "", end: "" };
  const header: CorpusHeader = {
    fin_corpus: CORPUS_FORMAT,
    created_at: opts.createdAt ?? new Date().toISOString(),
    source: opts.source,
    window,
    count: ordered.length,
    ...(opts.note ? { note: opts.note } : {}),
  };
  const lines = [JSON.stringify(header), ...ordered.map(canonicalLine)];
  return { text: lines.join("\n") + "\n", header };
}

// ---------------------------------------------------------------------------
// Parse / read
// ---------------------------------------------------------------------------

/** Parse corpus text. Throws CorpusError with the offending line number. Pure. */
export function parseCorpus(text: string): Corpus {
  const lines = text.split("\n");
  // Skip leading blank lines; the header must be the first non-blank line.
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) throw new CorpusError("empty file: expected a header line");

  let rawHeader: unknown;
  try {
    rawHeader = JSON.parse(lines[i]);
  } catch {
    throw new CorpusError("header is not JSON", i + 1);
  }
  const h = headerSchema.safeParse(rawHeader);
  if (!h.success) throw new CorpusError(`bad header: ${zodIssues(h.error)}`, i + 1);
  if (h.data.fin_corpus !== CORPUS_FORMAT) {
    throw new CorpusError(`unsupported corpus format ${h.data.fin_corpus} (this build reads ${CORPUS_FORMAT})`, i + 1);
  }
  isoOrThrow(h.data.created_at, "header.created_at", i + 1);

  const items: NewsItem[] = [];
  const ids = new Set<string>();
  for (let n = i + 1; n < lines.length; n++) {
    const line = lines[n];
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new CorpusError("item is not JSON", n + 1);
    }
    const r = newsItemSchema.safeParse(raw);
    if (!r.success) throw new CorpusError(`bad item: ${zodIssues(r.error)}`, n + 1);
    const item = r.data as NewsItem;
    if (!item.id) throw new CorpusError("item has an empty id", n + 1);
    if (ids.has(item.id)) throw new CorpusError(`duplicate item id ${item.id}`, n + 1);
    ids.add(item.id);
    isoOrThrow(item.published_at, "published_at", n + 1);
    isoOrThrow(item.ingested_at, "ingested_at", n + 1);
    items.push(item);
  }
  if (h.data.count !== undefined && h.data.count !== items.length) {
    throw new CorpusError(`header says count=${h.data.count} but the file has ${items.length} items`);
  }
  const header: CorpusHeader = {
    fin_corpus: CORPUS_FORMAT,
    created_at: h.data.created_at,
    source: h.data.source,
    window: h.data.window,
    count: items.length,
    ...(h.data.note ? { note: h.data.note } : {}),
  };
  return { header, items };
}

export async function readCorpus(path: string): Promise<Corpus> {
  return parseCorpus(await readFile(path, "utf8"));
}

/** sha256 (hex) of the file's bytes: the reproducibility key recorded on BENCHSUM rows. */
export async function corpusHash(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export function sidecarPath(path: string): string {
  return `${path}.sha256`;
}

/** `sha256sum` / `shasum -a 256` format, so `shasum -a 256 -c <file>.sha256` verifies it. */
export function formatSidecar(hash: string, file: string): string {
  return `${hash}  ${basename(file)}\n`;
}

/** The hash a sidecar file records, or null when there is no sidecar / it is unreadable. */
export async function readSidecarHash(path: string): Promise<string | null> {
  try {
    const text = await readFile(sidecarPath(path), "utf8");
    const m = /^([0-9a-f]{64})\b/i.exec(text.trim());
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export interface WriteResult {
  path: string;
  /** sha256 of the file bytes. */
  hash: string;
  /** sha256 of the canonical item lines only. */
  itemsHash: string;
  count: number;
  header: CorpusHeader;
}

/**
 * Write the corpus and its `.sha256` sidecar. Deterministic for a given
 * (items, createdAt): two writes of the same items in any order produce
 * byte-identical files.
 */
export async function writeCorpus(
  path: string,
  items: NewsItem[],
  opts: SerializeOptions & { sidecar?: boolean },
): Promise<WriteResult> {
  const { text, header } = serializeCorpus(items, opts);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  const hash = sha256Hex(text);
  if (opts.sidecar !== false) await writeFile(sidecarPath(path), formatSidecar(hash, path), "utf8");
  return { path, hash, itemsHash: itemsHash(items), count: header.count, header };
}

// ---------------------------------------------------------------------------
// Selection and mapping (pure; what replay.ts does between reading and triage)
// ---------------------------------------------------------------------------

export interface SelectOptions {
  /** Keep at most this many, earliest first (the archive mode caps by arrival order; here it is chronological). */
  maxEvents?: number;
  /** Optional window clip, ISO strings; inclusive start, exclusive end. */
  start?: string;
  end?: string;
}

/** Ordered, clipped to the window, capped. */
export function selectEvents(items: NewsItem[], opts: SelectOptions = {}): NewsItem[] {
  const startMs = opts.start ? Date.parse(opts.start) : -Infinity;
  const endMs = opts.end ? Date.parse(opts.end) : Infinity;
  const kept = orderItems(items).filter((it) => {
    const ms = Date.parse(it.published_at);
    return ms >= startMs && ms < endMs;
  });
  return opts.maxEvents !== undefined && Number.isFinite(opts.maxEvents) ? kept.slice(0, Math.max(0, opts.maxEvents)) : kept;
}

/** A triaged corpus item as the runner's BenchEvent. `passed` is the threshold under test, not the live one. */
export function toBenchEvent(
  item: NewsItem,
  verdict: Pick<TriageVerdict, "materiality" | "hypotheses"> & Partial<Pick<TriageVerdict, "event_type" | "touches_positions">>,
  threshold: number,
): BenchEvent {
  const materiality = Number.isFinite(verdict.materiality) ? verdict.materiality : 0;
  return {
    item,
    hypotheses: Array.isArray(verdict.hypotheses) ? verdict.hypotheses.map(String) : [],
    materiality,
    passed: materiality >= threshold,
    // For variants with their own admission rule (yield-triage).
    eventType: verdict.event_type,
    touchesPositions: verdict.touches_positions,
  };
}

// ---------------------------------------------------------------------------
// Public-domain filter (for a corpus that may be redistributed)
// ---------------------------------------------------------------------------

/**
 * Source families whose text is public-domain: SEC EDGAR (US federal work) and
 * the disasters poller (USGS, NOAA/NHC, and GDACS alerts). "prwire", "crypto"
 * and "macro" carry publisher copy and are never shipped.
 */
export const PUBLIC_DOMAIN_FAMILIES: ReadonlySet<string> = new Set(["edgar", "disaster"]);

/** Wire-service and crypto-press fingerprints that must not appear in a redistributed corpus, wherever they came from. */
const NON_PUBLIC_DOMAIN_PATTERN =
  /\b(PR ?Newswire|Business ?Wire|Globe ?Newswire|Accesswire|Newsfile|Reuters|Bloomberg|Dow Jones|Associated Press|CoinDesk|Cointelegraph|The Block|Decrypt|CryptoSlate|Bitcoin Magazine|Benzinga|MarketWatch)\b/i;

const NON_PUBLIC_DOMAIN_HOSTS =
  /(^|\.)(prnewswire|businesswire|globenewswire|accesswire|newsfilecorp|reuters|bloomberg|coindesk|cointelegraph|theblock|decrypt|cryptoslate|bitcoinmagazine|benzinga|marketwatch)\.[a-z.]+$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Public-domain family AND nothing about it reads as wire-service or crypto-press copy. */
export function isPublicDomainItem(item: NewsItem): boolean {
  if (!PUBLIC_DOMAIN_FAMILIES.has(item.source_family)) return false;
  if (NON_PUBLIC_DOMAIN_PATTERN.test(item.headline)) return false;
  if (NON_PUBLIC_DOMAIN_PATTERN.test(item.summary.slice(0, 400))) return false;
  if (NON_PUBLIC_DOMAIN_HOSTS.test(hostOf(item.url))) return false;
  return true;
}

export function publicDomainItems(items: NewsItem[]): NewsItem[] {
  return items.filter(isPublicDomainItem);
}
