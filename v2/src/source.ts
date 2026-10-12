// SPDX-License-Identifier: MIT-0
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { config } from "./config.js";
import type { NewsItem } from "./types.js";
import { guardedFetch } from "./urlguard.js";

/**
 * The document the event actually refers to, rather than a page about it.
 *
 * Why this exists: an EDGAR 8-K arrives with no filing text at all. v1's poller
 * sets `full_text = strip_html(entry.summary)` and the Atom summary is metadata
 * only — "Filed: 2026-09-03 AccNo: 0001213900-26-097296 Size: 374 KB
 * Item 3.01", so the agent is asked to judge an item code and a byte count.
 * Across the first 18 live equity decisions it held every time, and four of
 * those holds say outright that the filing could not be read ("Three searches
 * could not surface the filing's contents" — SFNC, 2026-09-03). Web search does
 * not substitute: nothing indexes a filing minutes old.
 *
 * Immutability is why the bench can use this while web search stays off. A
 * document addressed by EDGAR accession number, and an archived body in S3, are
 * both fixed at publication and read the same today as they did then. A live
 * feed page is rewritten in place — an NHC advisory URL holds the *latest*
 * advisory, not the one being replayed — so in bench mode those are refused
 * rather than silently showing the agent the future.
 */

/** 2 MB of a submission is far past the primary document; exhibits follow it. */
const MAX_FETCH_BYTES = 2_000_000;
/** What the agent is handed. Roughly 6k tokens: an 8-K body plus a press release. */
const MAX_TEXT_CHARS = 24_000;
const FETCH_TIMEOUT_MS = 25_000;

const s3 = new S3Client({ region: config.region });

export type SourceKind = "edgar" | "archived-body" | "web";

export interface SourceFetch {
  source: SourceKind;
  /** Where it came from, for the transcript. */
  ref: string;
  text: string;
  truncated: boolean;
  meta?: Record<string, unknown>;
}

/**
 * SEC fair access requires a declared identity (a User-Agent carrying a
 * reachable contact) and caps requests at 10/s. There is deliberately no
 * fallback: an anonymous or made-up contact is exactly what the policy exists
 * to refuse, so an unset contact is a configuration error, surfaced to the
 * agent as a read failure rather than sent to EDGAR.
 */
function edgarUserAgent(): string {
  const contact = config.edgarContact.trim();
  if (!contact) {
    throw new Error(
      "EDGAR requests need an identifying contact: set V2_EDGAR_CONTACT (or EDGAR_CONTACT) " +
        "to an email address the SEC can reach (see https://www.sec.gov/os/accessing-edgar-data)",
    );
  }
  return `fin-paper-trader/0.2 (${contact})`;
}

export interface EdgarRef {
  cik: string;
  accession: string;
  submissionUrl: string;
}

/**
 * An EDGAR URL names its filing by accession number, which is enough to fetch
 * the complete submission. Handles the Atom feed's `-index.htm` links and bare
 * directory URLs alike.
 */
export function edgarRef(url: string): EdgarRef | null {
  const m = /sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})/i.exec(url);
  if (!m) return null;
  const [, cik, digits] = m;
  const accession = `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
  return {
    cik,
    accession,
    submissionUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${digits}/${accession}.txt`,
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", reg: "®",
  trade: "™", copy: "©", deg: "°",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Filing HTML to something a model can read. Inline-XBRL filings open with an
 * `ix:header` block of a few hundred context tags; left in, it is the first
 * thing the agent sees and says nothing.
 */
export function htmlToText(html: string): string {
  let t = html.replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ");
  t = t.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<\/(p|div|tr|li|table|h[1-6])\s*>/gi, "\n");
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<[^>]*>/g, " ");
  t = decodeEntities(t);
  t = t.replace(/[ \t\u00a0\u200b]+/g, " ");
  t = t.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

export interface SubmissionHeader {
  form: string;
  filer: string;
  cik: string;
  filed: string;
  period: string;
  items: string[];
}

/**
 * The dissemination header of a full submission. Note it is plain text with
 * tab-aligned labels, NOT the SGML tag form that `<accession>-index-headers.html`
 * shows — reading `<ITEMS>` out of the .txt silently yields nothing. Only the
 * text before </SEC-HEADER> is considered, so a document body cannot spoof it.
 */
export function parseSubmissionHeader(submission: string): SubmissionHeader {
  const end = submission.indexOf("</SEC-HEADER>");
  const head = end >= 0 ? submission.slice(0, end) : submission.slice(0, 8_000);
  const one = (label: string) =>
    new RegExp(`^${label}:\\s*(.+)$`, "im").exec(head)?.[1]?.trim() ?? "";
  return {
    form: one("CONFORMED SUBMISSION TYPE"),
    filer: one("[ \\t]*COMPANY CONFORMED NAME"),
    cik: one("[ \\t]*CENTRAL INDEX KEY"),
    filed: one("FILED AS OF DATE"),
    period: one("CONFORMED PERIOD OF REPORT"),
    items: [...head.matchAll(/^ITEM INFORMATION:\s*(.+)$/gim)].map((m) => m[1].trim()),
  };
}

export interface EdgarDoc {
  type: string;
  sequence: number;
  filename: string;
  description: string;
  text: string;
}

/** Exhibits that are machine plumbing, not disclosure. */
const SKIP_TYPE = /^(EX-101|EX-96|GRAPHIC|ZIP|EXCEL|XML|JSON|CERT)/i;
const SKIP_FILE = /\.(xml|xsd|zip|jpg|jpeg|png|gif|pdf|css|js)$/i;

/**
 * Split a full submission text file into its documents. The dissemination
 * format is SGML: each document carries TYPE, SEQUENCE, FILENAME and
 * DESCRIPTION before its TEXT. A truncated stream leaves the last block
 * unterminated, which is fine — it is an exhibit we were not going to read.
 */
export function edgarDocuments(submission: string): EdgarDoc[] {
  const out: EdgarDoc[] = [];
  const re = /<DOCUMENT>([\s\S]*?)(?:<\/DOCUMENT>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(submission)) !== null) {
    const block = m[1];
    const field = (name: string) =>
      new RegExp(`<${name}>[ \\t]*(.*)`, "i").exec(block)?.[1]?.trim() ?? "";
    const raw = /<TEXT>([\s\S]*)/i.exec(block)?.[1] ?? "";
    out.push({
      type: field("TYPE"),
      sequence: Number(field("SEQUENCE")) || out.length + 1,
      filename: field("FILENAME"),
      description: field("DESCRIPTION"),
      text: raw.replace(/<\/TEXT>\s*$/i, ""),
    });
    if (m[0].length === 0) break;
  }
  return out;
}

/** The filing itself plus any press release; everything else is listed, not read. */
export function selectEdgarDocs(docs: EdgarDoc[]): { keep: EdgarDoc[]; listed: EdgarDoc[] } {
  const readable = docs.filter((d) => !SKIP_TYPE.test(d.type) && !SKIP_FILE.test(d.filename));
  const keep = readable.filter(
    (d, i) => i === 0 || /^EX-99/i.test(d.type),
  );
  const listed = docs.filter((d) => !keep.includes(d));
  return { keep, listed };
}

/** Every source fetch goes through the outbound guard (`urlguard.ts`), EDGAR included. */
async function fetchCapped(url: string, headers: Record<string, string>): Promise<string> {
  const resp = await guardedFetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  if (!resp.body) return (await resp.text()).slice(0, MAX_FETCH_BYTES);
  // EDGAR ignores Range on Archives (verified 2026-09-03: a bytes=0-400000
  // request returns 200 and the whole file), so the cap has to be applied here;
  // some 8-K submissions are 14 MB of exhibits.
  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  while (n < MAX_FETCH_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    n += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

async function readEdgar(ref: EdgarRef): Promise<SourceFetch> {
  const submission = await fetchCapped(ref.submissionUrl, {
    "user-agent": edgarUserAgent(),
    accept: "text/plain",
  });
  const docs = edgarDocuments(submission);
  if (docs.length === 0) throw new Error("no documents in submission");
  const { keep, listed } = selectEdgarDocs(docs);
  const header = parseSubmissionHeader(submission);
  const parts = keep.map(
    (d) => `--- ${d.type} ${d.filename}${d.description ? ` (${d.description})` : ""} ---\n${htmlToText(d.text)}`,
  );
  const joined = parts.join("\n\n");
  return {
    source: "edgar",
    ref: ref.submissionUrl,
    text: joined.slice(0, MAX_TEXT_CHARS),
    truncated: joined.length > MAX_TEXT_CHARS,
    meta: {
      accession: ref.accession,
      ...header,
      read: keep.map((d) => `${d.type}:${d.filename}`),
      not_read: listed.map((d) => `${d.type}:${d.filename}${d.description ? ` (${d.description})` : ""}`),
    },
  };
}

async function readArchivedBody(uri: string): Promise<SourceFetch> {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new Error(`not an s3 uri: ${uri}`);
  const r = await s3.send(new GetObjectCommand({ Bucket: m[1], Key: m[2] }));
  const body = (await r.Body?.transformToString()) ?? "";
  const text = body.includes("<") ? htmlToText(body) : body.trim();
  return {
    source: "archived-body",
    ref: uri,
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
  };
}

async function readWeb(url: string): Promise<SourceFetch> {
  const raw = await fetchCapped(url, {
    "user-agent": edgarUserAgent(),
    accept: "text/html,text/plain,application/xhtml+xml",
  });
  const text = htmlToText(raw);
  return {
    source: "web",
    ref: url,
    text: text.slice(0, MAX_TEXT_CHARS),
    truncated: text.length > MAX_TEXT_CHARS,
  };
}

export interface ReadSourceOpts {
  /** Replay: refuse sources that are not fixed at publication time. */
  bench?: boolean;
}

/**
 * Read the event's own source, preferring the fixed addresses. Order matters:
 * an EDGAR item's `body_s3_uri` (when it has one) holds the poller's stripped
 * Atom summary, not the filing, so the accession wins.
 */
export async function readSource(
  item: Pick<NewsItem, "url" | "body_s3_uri">,
  opts: ReadSourceOpts = {},
): Promise<SourceFetch | { error: string }> {
  const errors: string[] = [];
  const ed = item.url ? edgarRef(item.url) : null;
  if (ed) {
    try {
      return await readEdgar(ed);
    } catch (e) {
      errors.push(`EDGAR ${ed.accession}: ${String(e)}`);
    }
  }
  if (item.body_s3_uri) {
    try {
      return await readArchivedBody(item.body_s3_uri);
    } catch (e) {
      errors.push(`archived body: ${String(e)}`);
    }
  }
  if (item.url && !ed) {
    if (opts.bench) {
      return {
        error:
          `this event's only source is a live page (${item.url}) that the publisher ` +
          "rewrites in place, so reading it now would show you a later state of the " +
          "world than the event. Refused in replay. Judge the event on what it says.",
      };
    }
    try {
      return await readWeb(item.url);
    } catch (e) {
      errors.push(`fetch ${item.url}: ${String(e)}`);
    }
  }
  return {
    error: errors.length
      ? `could not read the source — ${errors.join("; ")}`
      : "this event carries no source document (no url, no archived body)",
  };
}
