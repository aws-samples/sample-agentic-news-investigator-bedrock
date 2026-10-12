// SPDX-License-Identifier: MIT-0
import type { NewsItem } from "../types.js";

/**
 * Build a bench corpus from public historical sources, on the user's own
 * machine: the USGS earthquake catalog and SEC EDGAR's daily form index. The
 * repository ships no corpus (no dataset is distributed); this turns a date
 * range into one, in the same wire shape the live pollers publish, so a fresh
 * checkout can run the bench without first collecting news.
 *
 * Pure: parsing and mapping only. The fetching lives in the CLI
 * (build-public-corpus.ts), so tests import this module without network.
 *
 * NOAA NHC advisories are not covered: the archive has no date-range query,
 * only per-storm pages whose issuance times are local-time text.
 */

// ---------------------------------------------------------------------------
// USGS (mirrors lambdas/poller-disasters)
// ---------------------------------------------------------------------------

/** The live poller's threshold: smaller quakes never become news items. */
export const USGS_MIN_MAGNITUDE = 5.5;

/** `2026-08-17 03:14:22.310 UTC`, the way chrono's DateTime<Utc> prints in the poller. */
export function rustUtcDisplay(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-08-17T03:14:22.310Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)} UTC`;
}

/** One USGS FDSN GeoJSON feature -> the poller's NewsItem, or null below the bar. */
export function usgsItem(feature: any, minMagnitude = USGS_MIN_MAGNITUDE): NewsItem | null {
  const p = feature?.properties;
  const id = feature?.id;
  const mag = p?.mag;
  const time = p?.time;
  if (typeof id !== "string" || typeof mag !== "number" || typeof time !== "number") return null;
  if (mag < minMagnitude) return null;
  const place: string = typeof p.place === "string" && p.place ? p.place : "unknown location";
  const url: string = typeof p.url === "string" ? p.url : "";
  const tsunami = p.tsunami === 1;
  const m = mag.toFixed(1);
  const summary =
    `USGS reports a magnitude ${m} earthquake, ${place}. Tsunami flag: ${tsunami}. ` +
    `Detected at ${rustUtcDisplay(time)}. Details: ${url}`;
  const at = new Date(time).toISOString();
  return {
    id: `usgs-${id}`,
    source_family: "disaster",
    source_id: id,
    published_at: at,
    ingested_at: at,
    headline: `EARTHQUAKE: M${m} ${place}`,
    summary,
    url,
    tickers_hint: [],
  };
}

export function usgsItems(geojson: any, minMagnitude = USGS_MIN_MAGNITUDE): NewsItem[] {
  const out: NewsItem[] = [];
  for (const f of geojson?.features ?? []) {
    const item = usgsItem(f, minMagnitude);
    if (item) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SEC EDGAR (mirrors lambdas/poller-edgar's Atom entries)
// ---------------------------------------------------------------------------

export interface FormIndexRow {
  form: string;
  company: string;
  cik: number;
  /** YYYYMMDD */
  dateFiled: string;
  /** e.g. edgar/data/38723/0000038723-26-000042.txt */
  path: string;
  accession: string;
}

/**
 * Parse EDGAR's daily `form.YYYYMMDD.idx`: a preamble, a dashed rule, then
 * fixed-width rows separated by runs of spaces (company names contain single
 * spaces, never two in a row).
 */
export function parseFormIndex(text: string): FormIndexRow[] {
  const lines = text.split(/\r?\n/);
  const rule = lines.findIndex((l) => /^-{20,}\s*$/.test(l));
  const rows: FormIndexRow[] = [];
  for (const line of lines.slice(rule + 1)) {
    const m = /^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d{8})\s{2,}(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ form: m[1], company: m[2].trim(), cik: Number(m[3]), dateFiled: m[4], path: m[5], accession: m[6] });
  }
  return rows;
}

/** The forms the live poller's feed carries (`type=8-K` returns amendments too). */
export function isEightK(row: FormIndexRow): boolean {
  return row.form === "8-K" || row.form === "8-K/A";
}

/** Form 8-K item names as EDGAR's headers spell them -> item numbers. */
export const EIGHT_K_ITEMS: Readonly<Record<string, string>> = {
  "Entry into a Material Definitive Agreement": "1.01",
  "Termination of a Material Definitive Agreement": "1.02",
  "Bankruptcy or Receivership": "1.03",
  "Mine Safety - Reporting of Shutdowns and Patterns of Violations": "1.04",
  "Material Cybersecurity Incidents": "1.05",
  "Completion of Acquisition or Disposition of Assets": "2.01",
  "Results of Operations and Financial Condition": "2.02",
  "Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement of a Registrant": "2.03",
  "Triggering Events That Accelerate or Increase a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement": "2.04",
  "Costs Associated with Exit or Disposal Activities": "2.05",
  "Material Impairments": "2.06",
  "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard; Transfer of Listing": "3.01",
  "Unregistered Sales of Equity Securities": "3.02",
  "Material Modification to Rights of Security Holders": "3.03",
  "Changes in Registrant's Certifying Accountant": "4.01",
  "Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review": "4.02",
  "Changes in Control of Registrant": "5.01",
  "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers: Compensatory Arrangements of Certain Officers": "5.02",
  "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year": "5.03",
  "Temporary Suspension of Trading Under Registrant's Employee Benefit Plans": "5.04",
  "Amendments to the Registrant's Code of Ethics, or Waiver of a Provision of the Code of Ethics": "5.05",
  "Change in Shell Company Status": "5.06",
  "Submission of Matters to a Vote of Security Holders": "5.07",
  "Shareholder Director Nominations": "5.08",
  "ABS Informational and Computational Material": "6.01",
  "Change of Servicer or Trustee": "6.02",
  "Change in Credit Enhancement or Other External Support": "6.03",
  "Failure to Make a Required Distribution": "6.04",
  "Securities Act Updating Disclosure": "6.05",
  "Regulation FD Disclosure": "7.01",
  "Other Events": "8.01",
  "Financial Statements and Exhibits": "9.01",
};

export interface FilingHeader {
  /** ISO UTC instant EDGAR accepted the filing. */
  acceptedAt: string;
  /** "Item 2.02: Results of Operations and Financial Condition", or the bare name when unmapped. */
  items: string[];
}

/**
 * America/New_York wall-clock time -> UTC ISO. EDGAR stamps acceptance in
 * Eastern time; the offset (EST/EDT) is taken from Intl for that instant.
 */
export function easternToUtcIso(yyyymmddhhmmss: string): string {
  const d = yyyymmddhhmmss;
  const [y, mo, da, h, mi, s] = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10), d.slice(10, 12), d.slice(12, 14)].map(Number);
  const asUtc = Date.UTC(y, mo - 1, da, h, mi, s);
  // The offset New York had at (approximately) that instant; re-check once at the corrected instant.
  const offsetAt = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - ms;
  };
  let ms = asUtc - offsetAt(asUtc);
  ms = asUtc - offsetAt(ms);
  return new Date(ms).toISOString();
}

/** Parse `<accession>-index-headers.html`: acceptance time and item names. */
export function parseFilingHeader(html: string): FilingHeader | null {
  const acc = /ACCEPTANCE-DATETIME(?:>|&gt;)\s*(\d{14})/.exec(html);
  if (!acc) return null;
  const items: string[] = [];
  for (const m of html.matchAll(/ITEM INFORMATION:\s*([^\r\n<]+)/g)) {
    const name = m[1].trim();
    const code = EIGHT_K_ITEMS[name];
    const label = code ? `Item ${code}: ${name}` : name;
    if (!items.includes(label)) items.push(label);
  }
  return { acceptedAt: easternToUtcIso(acc[1]), items };
}

/** The EDGAR Atom feed's 10-digit CIK. */
export function padCik(cik: number): string {
  return String(cik).padStart(10, "0");
}

/**
 * A daily-index row plus its header -> the poller's NewsItem. The Atom entry's
 * id, title and `-index.htm` link are reproduced so `read_source` and filing
 * enrichment resolve the filing by accession exactly as for a live item.
 */
export function edgarItem(row: FormIndexRow, header: FilingHeader, ticker?: string): NewsItem {
  const digits = row.accession.replace(/-/g, "");
  const filed = `${row.dateFiled.slice(0, 4)}-${row.dateFiled.slice(4, 6)}-${row.dateFiled.slice(6, 8)}`;
  const summary = [`Filed: ${filed} AccNo: ${row.accession}`, ...header.items].join("\n");
  return {
    id: `edgar-${row.accession}`,
    source_family: "edgar",
    source_id: `urn:tag:sec.gov,2008:accession-number=${row.accession}`,
    published_at: header.acceptedAt,
    ingested_at: header.acceptedAt,
    headline: `${row.form} - ${row.company} (${padCik(row.cik)}) (Filer)`,
    summary,
    url: `https://www.sec.gov/Archives/edgar/data/${row.cik}/${digits}/${row.accession}-index.htm`,
    tickers_hint: ticker ? [ticker] : [],
    asset_class_hint: "equity",
  };
}

/** company_tickers.json -> CIK -> ticker (the first listed ticker wins, as in the poller). */
export function tickerMap(body: unknown): Map<number, string> {
  const out = new Map<number, string>();
  for (const e of Object.values((body ?? {}) as Record<string, any>)) {
    if (typeof e?.cik_str === "number" && typeof e?.ticker === "string" && !out.has(e.cik_str)) out.set(e.cik_str, e.ticker);
  }
  return out;
}

/**
 * Which 8-Ks of one day to keep: listed filers only (a ticker to trade),
 * at most `perDay`, in accession order so a rebuild picks the same filings.
 */
export function pickFilings(rows: FormIndexRow[], tickers: Map<number, string>, perDay: number): FormIndexRow[] {
  return rows
    .filter((r) => isEightK(r) && tickers.has(r.cik))
    .sort((a, b) => (a.accession < b.accession ? -1 : a.accession > b.accession ? 1 : 0))
    .slice(0, Math.max(0, perDay));
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Inclusive list of YYYY-MM-DD from `from` to `to`. Throws on bad input or a span over `maxDays`. */
export function daysBetween(from: string, to: string, maxDays = 31): string[] {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from) || !re.test(to)) throw new Error("dates must be YYYY-MM-DD");
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!(b >= a)) throw new Error("--to must not be before --from");
  const n = Math.round((b - a) / 86_400_000) + 1;
  if (n > maxDays) throw new Error(`at most ${maxDays} days per corpus (asked for ${n})`);
  return Array.from({ length: n }, (_, i) => new Date(a + i * 86_400_000).toISOString().slice(0, 10));
}

/** EDGAR's daily-index URL for one day (YYYY-MM-DD). */
export function formIndexUrl(day: string): string {
  const [y, m, d] = day.split("-");
  const q = Math.floor((Number(m) - 1) / 3) + 1;
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${y}${m}${d}.idx`;
}

export function filingHeaderUrl(row: FormIndexRow): string {
  const digits = row.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${row.cik}/${digits}/${row.accession}-index-headers.html`;
}
