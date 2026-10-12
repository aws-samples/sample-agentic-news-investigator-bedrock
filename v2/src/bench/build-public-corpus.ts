// SPDX-License-Identifier: MIT-0
/**
 * Build a bench corpus from public historical sources (USGS earthquake catalog,
 * SEC EDGAR daily index) for a date range. Entry point: running it fetches.
 * The parsing and mapping are in public-corpus.ts, which tests import instead.
 *
 *   npm run bench:build -- --from 2026-09-01 --to 2026-09-07 --out bench/corpus/w36.jsonl
 *     [--sources usgs,edgar] [--edgar-per-day 25] [--min-magnitude 5.5] [--note "…"]
 *
 * EDGAR needs V2_EDGAR_CONTACT (SEC fair access: an identifying User-Agent; at
 * most 10 requests/s, this stays near 5). Nothing touches AWS.
 */
import { config } from "../config.js";
import { writeCorpus } from "./corpus.js";
import {
  daysBetween,
  edgarItem,
  filingHeaderUrl,
  formIndexUrl,
  parseFilingHeader,
  parseFormIndex,
  pickFilings,
  tickerMap,
  usgsItems,
  USGS_MIN_MAGNITUDE,
} from "./public-corpus.js";
import type { NewsItem } from "../types.js";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEC_GAP_MS = 200; // ~5 requests/s, half SEC's fair-access ceiling

async function fetchText(url: string, headers: Record<string, string>): Promise<string | null> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (resp.status === 404 || resp.status === 403) return null; // no index that day (weekend, holiday) / refused
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  return resp.text();
}

async function buildUsgs(from: string, to: string, minMagnitude: number): Promise<NewsItem[]> {
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${from}&endtime=${end}&minmagnitude=${minMagnitude}&orderby=time-asc`;
  const body = await fetchText(url, {});
  if (!body) throw new Error("USGS catalog query refused");
  return usgsItems(JSON.parse(body), minMagnitude);
}

async function buildEdgar(days: string[], perDay: number): Promise<NewsItem[]> {
  const contact = config.edgarContact.trim();
  if (!contact || contact.endsWith("@example.com")) {
    throw new Error(
      "EDGAR needs an identifying contact: set V2_EDGAR_CONTACT to an email the SEC can reach " +
        "(https://www.sec.gov/os/accessing-edgar-data), or pass --sources usgs",
    );
  }
  const headers = { "user-agent": `fin-paper-trader/0.2 (${contact})` };
  const tickersBody = await fetchText("https://www.sec.gov/files/company_tickers.json", headers);
  if (!tickersBody) throw new Error("company_tickers.json refused (check V2_EDGAR_CONTACT)");
  const tickers = tickerMap(JSON.parse(tickersBody));
  const items: NewsItem[] = [];
  for (const day of days) {
    await sleep(SEC_GAP_MS);
    const idx = await fetchText(formIndexUrl(day), headers);
    if (!idx) {
      console.log(`[build] ${day}: no EDGAR index (weekend or holiday)`);
      continue;
    }
    const picked = pickFilings(parseFormIndex(idx), tickers, perDay);
    let kept = 0;
    for (const row of picked) {
      await sleep(SEC_GAP_MS);
      const html = await fetchText(filingHeaderUrl(row), headers);
      const header = html ? parseFilingHeader(html) : null;
      if (!header) {
        console.warn(`[build] ${row.accession}: no readable header, skipped`);
        continue;
      }
      items.push(edgarItem(row, header, tickers.get(row.cik)));
      kept++;
    }
    console.log(`[build] ${day}: ${kept} 8-K(s) from listed filers`);
  }
  return items;
}

async function main(): Promise<void> {
  const from = arg("from", "");
  const to = arg("to", from);
  const out = arg("out", "");
  if (!from || !out) {
    console.error("usage: npm run bench:build -- --from YYYY-MM-DD [--to YYYY-MM-DD] --out bench/corpus/<name>.jsonl [--sources usgs,edgar]");
    process.exit(2);
  }
  const days = daysBetween(from, to);
  const sources = new Set(arg("sources", "usgs,edgar").split(",").map((s) => s.trim()).filter(Boolean));
  for (const s of sources) if (s !== "usgs" && s !== "edgar") throw new Error(`unknown source "${s}" (usgs, edgar)`);
  const perDay = Number(arg("edgar-per-day", "25"));
  const minMagnitude = Number(arg("min-magnitude", String(USGS_MIN_MAGNITUDE)));

  const items: NewsItem[] = [];
  if (sources.has("usgs")) {
    const q = await buildUsgs(from, to, minMagnitude);
    console.log(`[build] USGS: ${q.length} earthquake(s) at M${minMagnitude}+`);
    items.push(...q);
  }
  if (sources.has("edgar")) items.push(...(await buildEdgar(days, perDay)));
  if (items.length === 0) throw new Error("nothing to write: no items in that range");

  const note =
    arg("note", "") ||
    `built from public sources (${[...sources].join(", ")}) for ${from}..${to} by bench:build; not shipped with the repository`;
  const r = await writeCorpus(out, items, {
    source: "public",
    window: { start: `${from}T00:00:00.000Z`, end: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString() },
    note,
  });
  console.log(`[build] wrote ${r.count} item(s) to ${r.path} (sha256 ${r.hash.slice(0, 12)}…)`);
}

main().catch((e) => {
  console.error("[build] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
