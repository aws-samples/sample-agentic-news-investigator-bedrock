// SPDX-License-Identifier: MIT-0
import { readSource, decodeEntities, htmlToText, type SourceFetch } from "./source.js";
import { bedrock as client } from "./bedrock.js";
import { config } from "./config.js";
import { priceUsage, type NormalizedUsage } from "./pricing.js";
import type { NewsItem } from "./types.js";
import { guardedCall, messageIntervened, type GuardrailRef } from "./guardrail.js";
import { activeGuardrail } from "./guardrail-runtime.js";

/**
 * Pre-triage enrichment for SEC filings.
 *
 * The EDGAR Atom feed carries no description of a filing: form type, filer,
 * CIK, item codes, accession, byte size. v1's poller stores that entry as the
 * body, so every 8-K reached triage as metadata and triage scored ~160 filings
 * a day on filer name plus item codes — which is where "a Gulf operator filing
 * in hurricane season plausibly contains storm disclosure" came from (the
 * 2026-09-04 letter: three empty filings were the day's most material items).
 *
 * Here the filing itself is fetched by accession (source.ts, immutable, so the
 * bench can do exactly the same) and Haiku writes two or three sentences plus
 * the item codes and the cover-page ticker. Triage then reads what the filing
 * SAYS. The investigator still reads the full document with read_source.
 *
 * Never throws and never blocks the worker for long: any failure returns the
 * item unchanged. Only v2/v3 see the enrichment; v1's inputs are untouched.
 */

export interface Enrichment {
  /** 2–3 sentences: what happened, to whom, the numbers, routine vs decisive. */
  summary: string;
  /** 8-K item codes the filing reports (e.g. "1.01", "2.02"). */
  items: string[];
  /** The registrant's listed trading symbol(s) from the cover page, upper-cased. */
  tickers: string[];
  /** Where the text came from (accession / URL), for the audit row. */
  source_ref: string;
  model: string;
  /** Haiku's reported usage for the summary and its cost at `model`'s rates (pricing.ts); absent when the summarizer reported none. */
  usage?: NormalizedUsage;
  cost_usd?: number;
}

export interface Summarized {
  summary: string;
  items: string[];
  tickers: string[];
  usage?: NormalizedUsage;
  cost_usd?: number;
  /** The Bedrock guardrail blocked the call; summary is empty, so the item goes to triage unchanged. */
  guardrail_intervened?: boolean;
}

export interface EnrichDeps {
  read?: (item: Pick<NewsItem, "url" | "body_s3_uri">) => Promise<SourceFetch | { error: string }>;
  summarize?: (text: string, item: NewsItem) => Promise<Summarized>;
  /** Whole-step deadline; on expiry the item is returned unchanged. */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const FILING_SUMMARY_MARKER = "Filing summary:";
/** Characters of filing text sent to the summarizer: the cover page and items come first. */
export const SUMMARY_INPUT_CHARS = 14_000;
const DEFAULT_TIMEOUT_MS = 20_000;
/** SEC fair access caps 10 req/s; the bench triages 8 events concurrently. */
const MAX_CONCURRENT_READS = 4;

/** Forms the feed carries that a summary helps: 8-K and its amendments. */
export function isFiling(item: Pick<NewsItem, "source_family" | "headline">): boolean {
  return item.source_family === "edgar" && /^8-K(\/A)?\b/.test(item.headline.trim());
}

/** Cover page, item list and the start of the body; exhibits beyond the cap are dropped. */
export function clipForSummary(text: string, max = SUMMARY_INPUT_CHARS): string {
  const t = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length <= max ? t : t.slice(0, max) + "\n[... truncated for summary ...]";
}

/** A new item with the summary appended and the cover-page tickers merged into tickers_hint. */
export function applyEnrichment(item: NewsItem, e: Enrichment): NewsItem {
  const tickers = [...new Set([...(item.tickers_hint ?? []), ...e.tickers].map((s) => s.trim().toUpperCase()).filter(Boolean))];
  // The feed's own line arrives entity-escaped ("&lt;b&gt;Filed:&lt;/b&gt; …"); make it legible.
  const base = htmlToText(decodeEntities(item.summary ?? "")).replace(/\s+/g, " ").trim();
  const itemsLine = e.items.length ? ` Items: ${e.items.join(", ")}.` : "";
  const summary = `${base}${base ? "\n\n" : ""}${FILING_SUMMARY_MARKER}${itemsLine} ${e.summary.trim()}`.trim();
  return { ...item, summary, tickers_hint: tickers, enrichment: e };
}

const SUMMARIZE_SYSTEM = [
  "You summarize SEC filings for a trading triage desk. You are given the text of one filing:",
  "cover page, the reported items, and a press-release exhibit when there is one.",
  "Return STRICT JSON with exactly these keys and no markdown:",
  '{"summary": string, "items": string[], "tickers": string[]}',
  "- summary: two or three sentences. What happened, to whom, with the concrete numbers the text",
  "  gives (dollar amounts, share counts, dates, percentages, the counterparty), and whether the text",
  "  reads as routine disclosure or as a decisive event (bankruptcy, delisting notice, restatement,",
  "  impairment, abrupt executive exit, completed acquisition, results that beat or miss). Say which.",
  "- items: the 8-K item codes the filing reports, as strings like \"1.01\".",
  "- tickers: the registrant's own trading symbol(s) from the cover page's Trading Symbol(s) table;",
  "  empty if the cover page shows none or the class is not listed.",
  "Do not speculate beyond the text. Do not infer what a company does from its name. If the text is",
  "only metadata or unreadable, say so in the summary and leave items/tickers empty.",
].join("\n");

export async function summarizeFiling(
  text: string,
  item: NewsItem,
  guardrail?: GuardrailRef | null,
): Promise<Summarized> {
  // The headline and the filing text are guard content; the date is ours.
  const g = guardedCall(activeGuardrail(guardrail));
  const resp = await client.messages.create(
    g.body({
      model: config.triageModel,
      max_tokens: 450,
      system: SUMMARIZE_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: g.active
            ? `Headline: ${g.tag(item.headline)}\nFiled: ${item.published_at}\n\n${g.tag(text)}`
            : `Headline: ${item.headline}\nFiled: ${item.published_at}\n\n${text}`,
        },
      ],
    }),
    { headers: g.headers },
  );
  if (g.active && messageIntervened(resp)) {
    const priced = priceUsage(config.triageModel, resp.usage);
    console.warn(`[guardrail] filing summary blocked for ${item.id}; triaging the bare entry`);
    return { summary: "", items: [], tickers: [], usage: priced.usage, cost_usd: priced.usd, guardrail_intervened: true };
  }
  const out = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const raw = out.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const parsed = JSON.parse(raw) as Partial<Summarized>;
  const priced = priceUsage(config.triageModel, resp.usage);
  return {
    summary: String(parsed.summary ?? "").trim(),
    items: Array.isArray(parsed.items) ? parsed.items.map((s) => String(s).trim()).filter(Boolean) : [],
    tickers: Array.isArray(parsed.tickers)
      ? parsed.tickers.map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))
      : [],
    usage: priced.usage,
    cost_usd: priced.usd,
  };
}

// A small gate on concurrent EDGAR reads (the bench triages 8 events at once).
let inFlight = 0;
const waiters: Array<() => void> = [];
async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_READS) await new Promise<void>((r) => waiters.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiters.shift()?.();
  }
}

/**
 * The item triage should see. Filings come back with a Filing summary appended
 * and cover-page tickers merged; everything else, and every failure, comes back
 * unchanged. Deadline-bounded; never throws.
 */
export async function enrichForTriage(item: NewsItem, deps: EnrichDeps = {}): Promise<NewsItem> {
  if (!isFiling(item)) return item;
  const log = deps.log ?? ((l: string) => console.log(l));
  const read = deps.read ?? ((i: Pick<NewsItem, "url" | "body_s3_uri">) => readSource(i));
  const summarize = deps.summarize ?? summarizeFiling;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
  });
  const work = (async (): Promise<NewsItem | "timeout"> => {
    const fetched = await withReadSlot(() => read({ url: item.url, body_s3_uri: item.body_s3_uri }));
    if ("error" in fetched) {
      log(`[enrich] ${item.id}: no filing text — ${fetched.error.slice(0, 160)}`);
      return item;
    }
    const s = await summarize(clipForSummary(fetched.text), item);
    if (!s.summary) return item;
    const enrichment: Enrichment = {
      summary: s.summary,
      items: s.items,
      tickers: s.tickers,
      source_ref: fetched.ref,
      model: config.triageModel,
      ...(s.usage ? { usage: s.usage, cost_usd: s.cost_usd ?? 0 } : {}),
    };
    log(`[enrich] ${item.id}: ${s.items.join(",") || "no items"} ${s.tickers.join(",") || "no ticker"} — ${s.summary.slice(0, 140)}`);
    return applyEnrichment(item, enrichment);
  })().catch((e) => {
    log(`[enrich] ${item.id}: failed — ${String(e).slice(0, 200)}`);
    return item;
  });

  const result = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (result === "timeout") {
    log(`[enrich] ${item.id}: timed out after ${timeoutMs} ms; triaging the bare entry`);
    return item;
  }
  return result;
}
