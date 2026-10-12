// SPDX-License-Identifier: MIT-0
/**
 * Pure shaping and formatting for `bench:compare`: BENCHSUM rows into an
 * aligned table, and two runs' `BENCH#` audit rows into a per-event decision
 * diff. No AWS here — replay.ts (the CLI) reads DynamoDB and hands the raw
 * items to these functions, so every line of output is testable with fixtures.
 *
 * Vocabulary: a RUN is one BENCHSUM row, keyed `<name>#<variant>`. Two runs are
 * comparable event by event only when they saw the same inputs, which is what
 * the corpus hash asserts (see corpus.ts: file hash when a corpus file was
 * used, canonical items hash otherwise).
 */

export interface BenchSummary {
  name: string;
  variant: string;
  /** `<name>#<variant>`: the BENCHSUM sort key. */
  runKey: string;
  arm: string | null;
  ranAt: string | null;
  window: string | null;
  windowDays: number | null;
  /** "archive" (EventBridge replay) or "corpus" (a JSONL file). Null on rows written before either was recorded. */
  input: string | null;
  corpusFile: string | null;
  /** sha256 of the corpus file bytes; null for archive runs. */
  corpusHash: string | null;
  /** sha256 of the canonical item lines; present on both modes since corpus support landed. */
  corpusItemsHash: string | null;
  threshold: number | null;
  eventsSeen: number;
  triagePassed: number;
  decided: number;
  buys: number;
  sells: number;
  holds: number;
  filled: number;
  dropped: number;
  errored: number;
  unscoreable: number;
  tradeMeanRet1d: number | null;
  tradeMeanRet7d: number | null;
  holdCounterfactualRet1d: number | null;
  costUsd: number;
  costPerDecision: number | null;
  finalEquity: number | null;
  returnOnSeed: number | null;
  stoppedReason: string | null;
}

const num0 = (v: unknown): number => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v: unknown): number | null => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** One BENCHSUM item (as stored by replay.ts) as a BenchSummary. Tolerates rows from before any given field existed. */
export function summaryFrom(item: Record<string, unknown>): BenchSummary {
  const sk = String(item.sk ?? "");
  const hash = sk.indexOf("#");
  const name = String(item.bench ?? (hash >= 0 ? sk.slice(0, hash) : sk));
  const variant = String(item.variant ?? (hash >= 0 ? sk.slice(hash + 1) : "live"));
  const decided = num0(item.decided);
  const costUsd = num0(item.cost_usd);
  const book = (item.book ?? null) as Record<string, unknown> | null;
  return {
    name,
    variant,
    runKey: `${name}#${variant}`,
    arm: strOrNull(item.arm),
    ranAt: strOrNull(item.ran_at),
    window: strOrNull(item.window),
    windowDays: numOrNull(item.window_days),
    input: strOrNull(item.input),
    corpusFile: strOrNull(item.corpus_file),
    corpusHash: strOrNull(item.corpus_hash),
    corpusItemsHash: strOrNull(item.corpus_items_hash),
    threshold: numOrNull(item.triage_threshold),
    eventsSeen: num0(item.events_seen),
    triagePassed: num0(item.triage_passed),
    decided,
    buys: num0(item.buys),
    sells: num0(item.sells),
    holds: num0(item.holds),
    filled: num0(item.filled),
    dropped: num0(item.dropped),
    errored: num0(item.errored),
    unscoreable: num0(item.unscoreable),
    tradeMeanRet1d: numOrNull(item.trade_mean_ret_1d),
    tradeMeanRet7d: numOrNull(item.trade_mean_ret_7d),
    holdCounterfactualRet1d: numOrNull(item.hold_counterfactual_ret_1d),
    costUsd,
    costPerDecision: decided > 0 ? costUsd / decided : null,
    finalEquity: book ? numOrNull(book.final_equity) : null,
    returnOnSeed: book ? numOrNull(book.return_on_seed) : null,
    stoppedReason: strOrNull(item.stopped_reason),
  };
}

/** The identity of a run's inputs: the file hash when there was a file, else the items hash. Null when neither was recorded. */
export function corpusKey(s: Pick<BenchSummary, "corpusHash" | "corpusItemsHash">): string | null {
  return s.corpusHash ?? s.corpusItemsHash ?? null;
}

/**
 * Same inputs? The items hash is what was actually run (after --max-events), so
 * when both runs have one it must match — and if both also have a file hash the
 * files must not disagree. Two runs with file hashes but no items hashes (rows
 * from before the items hash was recorded) compare on the file. Rows with
 * neither are never "the same": there is nothing to compare on.
 */
export function sameCorpus(
  a: Pick<BenchSummary, "corpusHash" | "corpusItemsHash">,
  b: Pick<BenchSummary, "corpusHash" | "corpusItemsHash">,
): boolean {
  if (a.corpusItemsHash && b.corpusItemsHash) {
    if (a.corpusItemsHash !== b.corpusItemsHash) return false;
    if (a.corpusHash && b.corpusHash && a.corpusHash !== b.corpusHash) return false;
    return true;
  }
  if (a.corpusHash && b.corpusHash) return a.corpusHash === b.corpusHash;
  return false;
}

/** All BENCHSUM items as summaries, grouped by corpus (identical inputs adjacent), then oldest run first. */
export function summariesFrom(items: Array<Record<string, unknown>>): BenchSummary[] {
  return items.map(summaryFrom).sort((a, b) => {
    const ka = corpusKey(a) ?? "~"; // rows without a corpus key sort last
    const kb = corpusKey(b) ?? "~";
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ra = a.ranAt ?? "";
    const rb = b.ranAt ?? "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.runKey < b.runKey ? -1 : a.runKey > b.runKey ? 1 : 0;
  });
}

/** Parse "--names a,b#terse" into run selectors: a bare name matches every variant, `name#variant` exactly one. */
export function parseRunSelectors(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function matchesSelector(s: Pick<BenchSummary, "name" | "runKey">, selector: string): boolean {
  return selector.includes("#") ? s.runKey === selector : s.name === selector;
}

/** Keep the summaries any selector matches; no selectors keeps everything. */
export function filterSummaries(rows: BenchSummary[], selectors: string[]): BenchSummary[] {
  if (selectors.length === 0) return rows;
  return rows.filter((s) => selectors.some((sel) => matchesSelector(s, sel)));
}

/** `name` or `name#variant` -> the BENCHSUM sort key; the variant defaults to "live". */
export function runKeyOf(selector: string): { name: string; variant: string; runKey: string } {
  const i = selector.indexOf("#");
  const name = i >= 0 ? selector.slice(0, i) : selector;
  const variant = i >= 0 && selector.slice(i + 1) ? selector.slice(i + 1) : "live";
  return { name, variant, runKey: `${name}#${variant}` };
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function shortHash(h: string | null, n = 12): string {
  return h ? h.slice(0, n) : "-";
}

export function fmtPct(x: number | null | undefined, digits = 2): string {
  return typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "n/a";
}

export function fmtUsd(x: number | null | undefined, digits = 2): string {
  return typeof x === "number" && Number.isFinite(x) ? `$${x.toFixed(digits)}` : "n/a";
}

type Align = "left" | "right";

/** Aligned text table: two-space gutters, right-aligned numeric columns, a rule under the header. */
export function renderTable(header: string[], rows: string[][], align: Align[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (align[i] === "right" ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), rule, ...rows.map(line)].join("\n");
}

const TABLE_HEADER = [
  "arm",
  "run",
  "input",
  "corpus",
  "ran",
  "seen",
  "passed",
  "decided",
  "buy/sell/hold",
  "filled",
  "dropped",
  "mean 1d",
  "mean 7d",
  "hold cf 1d",
  "unscoreable",
  "cost",
  "cost/decision",
];
const TABLE_ALIGN: Align[] = [
  "left",
  "left",
  "left",
  "left",
  "left",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
  "right",
];

export function tableRow(s: BenchSummary): string[] {
  return [
    s.arm ?? "-",
    s.runKey,
    s.input ?? "-",
    shortHash(corpusKey(s)),
    s.ranAt ? s.ranAt.slice(0, 10) : "-",
    String(s.eventsSeen),
    String(s.triagePassed),
    String(s.decided) + (s.errored ? ` (+${s.errored} err)` : ""),
    `${s.buys}/${s.sells}/${s.holds}`,
    String(s.filled),
    String(s.dropped),
    fmtPct(s.tradeMeanRet1d),
    fmtPct(s.tradeMeanRet7d),
    fmtPct(s.holdCounterfactualRet1d),
    String(s.unscoreable),
    fmtUsd(s.costUsd),
    fmtUsd(s.costPerDecision),
  ];
}

/** The comparison table. Rows are printed in the order given (use summariesFrom to group by corpus). */
export function formatCompareTable(rows: BenchSummary[]): string {
  if (rows.length === 0) return "(no BENCHSUM rows)";
  const body = renderTable(TABLE_HEADER, rows.map(tableRow), TABLE_ALIGN);
  const notes = [
    "corpus = sha256 prefix of the inputs (file hash for corpus runs, canonical items hash for archive runs); rows sharing it saw identical events.",
    "mean 1d/7d = mean signed return of the variant's trades at 1 and 7 days; hold cf 1d = the same for holds, scored as the counterfactual long.",
  ];
  return `${body}\n\n${notes.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Per-event diff
// ---------------------------------------------------------------------------

/** The shape putAudit() stores: pk `BENCH#…`, sk `EVT#<iso>#<stage>`, stage, payload. */
export interface AuditItem {
  pk: string;
  sk: string;
  stage: string;
  payload: unknown;
}

export interface DecisionRecord {
  newsId: string;
  headline: string;
  publishedAt: string | null;
  sourceFamily: string | null;
  materiality: number | null;
  /** Cleared the run's threshold (null when the run's threshold is unknown). */
  passed: boolean | null;
  /** An investigation produced a decision. */
  investigated: boolean;
  errored: boolean;
  action: string | null;
  symbol: string | null;
  confidence: number | null;
  notionalUsd: number | null;
  /** "filled 12 @ 3.45" | "dropped: insufficient_cash" | "parked until …" | "hold" | null */
  outcome: string | null;
  ret1d: number | null;
  ret7d: number | null;
  costUsd: number;
  numActions: number;
}

type Decision = { action?: string; symbol?: string; watch_symbol?: string; confidence?: number; notional_usd?: number };
type Outcome = {
  status?: string;
  reason?: string;
  fill_at?: string;
  fill?: { side?: string; qty?: number; fillPrice?: number; notionalUsd?: number };
};

function outcomeText(d: Decision, o: Outcome | undefined): string {
  if (d.action === "hold") return "hold";
  if (!o) return "-";
  if (o.status === "filled" && o.fill) return `filled ${o.fill.qty ?? "?"} @ ${o.fill.fillPrice ?? "?"}`;
  if (o.status === "parked") return `parked until ${o.fill_at ?? "?"}`;
  if (o.status === "dropped") return `dropped: ${o.reason ?? "?"}`;
  return o.status ?? "-";
}

/** Latest audit item per pk (a re-run under the same name leaves several EVT# rows; the newest wins). */
export function latestPerPk(items: AuditItem[]): Map<string, AuditItem> {
  const out = new Map<string, AuditItem>();
  for (const it of items) {
    const prev = out.get(it.pk);
    if (!prev || it.sk > prev.sk) out.set(it.pk, it);
  }
  return out;
}

/**
 * One run's per-event records from its `BENCH#` audit rows: the shared
 * `bench-triage` rows under `BENCH#<name>#<newsId>` give every event seen
 * (headline, materiality); the variant's `bench-decision` rows under
 * `BENCH#<name>#<variant>#<newsId>` give what it decided. Rows for other
 * variants of the same name are ignored.
 */
export function recordsFrom(
  items: AuditItem[],
  run: { name: string; variant: string },
  threshold: number | null,
): Map<string, DecisionRecord> {
  const triagePrefix = `BENCH#${run.name}#`;
  const decisionPrefix = `BENCH#${run.name}#${run.variant}#`;
  const out = new Map<string, DecisionRecord>();
  const blank = (newsId: string): DecisionRecord => ({
    newsId,
    headline: "",
    publishedAt: null,
    sourceFamily: null,
    materiality: null,
    passed: null,
    investigated: false,
    errored: false,
    action: null,
    symbol: null,
    confidence: null,
    notionalUsd: null,
    outcome: null,
    ret1d: null,
    ret7d: null,
    costUsd: 0,
    numActions: 0,
  });

  for (const it of latestPerPk(items).values()) {
    const p = (it.payload ?? {}) as Record<string, unknown>;
    if (it.stage === "bench-triage" && it.pk.startsWith(triagePrefix)) {
      const rest = it.pk.slice(triagePrefix.length);
      // A decision pk of THIS variant also starts with the triage prefix; skip those here.
      if (rest.startsWith(`${run.variant}#`)) continue;
      const rec = out.get(rest) ?? blank(rest);
      rec.headline = String(p.headline ?? rec.headline);
      rec.publishedAt = strOrNull(p.published_at) ?? rec.publishedAt;
      rec.sourceFamily = strOrNull(p.source_family) ?? rec.sourceFamily;
      rec.materiality = numOrNull(p.materiality);
      rec.passed = threshold !== null && rec.materiality !== null ? rec.materiality >= threshold : null;
      out.set(rest, rec);
    } else if (it.stage === "bench-decision" && it.pk.startsWith(decisionPrefix)) {
      const newsId = it.pk.slice(decisionPrefix.length);
      const rec = out.get(newsId) ?? blank(newsId);
      rec.headline = rec.headline || String(p.headline ?? "");
      rec.costUsd = num0(p.cost_usd);
      if (p.errored === true) {
        rec.errored = true;
        rec.investigated = false;
      } else {
        rec.investigated = true;
        const decisions = (Array.isArray(p.decisions) ? p.decisions : []) as Decision[];
        const outcomes = (Array.isArray(p.outcomes) ? p.outcomes : []) as Outcome[];
        const idx = Math.max(0, decisions.findIndex((d) => d.action !== "hold"));
        const primary = decisions[idx];
        if (primary) {
          rec.action = primary.action ?? null;
          rec.symbol = primary.symbol ?? primary.watch_symbol ?? null;
          rec.confidence = numOrNull(primary.confidence);
          rec.notionalUsd = numOrNull(primary.notional_usd);
          rec.outcome = outcomeText(primary, outcomes[idx]);
        }
        rec.numActions = decisions.length;
        rec.ret1d = numOrNull(p.ret_1d);
        rec.ret7d = numOrNull(p.ret_7d);
      }
      out.set(newsId, rec);
    }
  }
  return out;
}

export interface DiffLine {
  newsId: string;
  headline: string;
  publishedAt: string | null;
  a: DecisionRecord | null;
  b: DecisionRecord | null;
  same: boolean;
  /** Why they differ (or "same"). */
  note: string;
}

function norm(s: string | null): string {
  return (s ?? "").trim().toUpperCase();
}

function stateOf(r: DecisionRecord | null): string {
  if (!r) return "absent";
  if (r.errored) return "errored";
  if (!r.investigated) return r.passed === false ? "triage-failed" : "not-investigated";
  return `${r.action ?? "?"} ${norm(r.symbol) || "-"}`;
}

/** Compare one event across two runs. Same = same state (both not investigated, or same action on the same symbol). Size and fill are reported, not judged. */
export function diffRecord(a: DecisionRecord | null, b: DecisionRecord | null): { same: boolean; note: string } {
  const sa = stateOf(a);
  const sb = stateOf(b);
  if (sa === sb) return { same: true, note: "same" };
  return { same: false, note: `${sa} -> ${sb}` };
}

/** Union of both runs' events, in event order (published_at when the triage row recorded it, else by id). */
export function diffRuns(a: Map<string, DecisionRecord>, b: Map<string, DecisionRecord>): DiffLine[] {
  const ids = new Set<string>([...a.keys(), ...b.keys()]);
  const lines: DiffLine[] = [];
  for (const id of ids) {
    const ra = a.get(id) ?? null;
    const rb = b.get(id) ?? null;
    const { same, note } = diffRecord(ra, rb);
    lines.push({
      newsId: id,
      headline: ra?.headline || rb?.headline || "",
      publishedAt: ra?.publishedAt ?? rb?.publishedAt ?? null,
      a: ra,
      b: rb,
      same,
      note,
    });
  }
  return lines.sort((x, y) => {
    const tx = x.publishedAt ? Date.parse(x.publishedAt) : NaN;
    const ty = y.publishedAt ? Date.parse(y.publishedAt) : NaN;
    if (Number.isFinite(tx) && Number.isFinite(ty) && tx !== ty) return tx - ty;
    if (Number.isFinite(tx) !== Number.isFinite(ty)) return Number.isFinite(tx) ? -1 : 1;
    return x.newsId < y.newsId ? -1 : x.newsId > y.newsId ? 1 : 0;
  });
}

function cell(r: DecisionRecord | null): string {
  if (!r) return "absent";
  if (r.errored) return "errored";
  if (!r.investigated) return r.passed === false ? `triage ${r.materiality ?? "?"}` : "not investigated";
  const conf = r.confidence !== null ? ` c${r.confidence.toFixed(2)}` : "";
  const size = r.notionalUsd !== null ? ` $${Math.round(r.notionalUsd)}` : "";
  const ret = r.ret1d !== null ? ` 1d ${fmtPct(r.ret1d)}` : "";
  return `${r.action ?? "?"} ${r.symbol ?? "-"}${conf}${size} | ${r.outcome ?? "-"}${ret}`;
}

export interface DiffSummary {
  events: number;
  same: number;
  differ: number;
  onlyA: number;
  onlyB: number;
}

export function summarizeDiff(lines: DiffLine[]): DiffSummary {
  let same = 0;
  let differ = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (const l of lines) {
    if (!l.a) onlyB++;
    else if (!l.b) onlyA++;
    if (l.same) same++;
    else differ++;
  }
  return { events: lines.length, same, differ, onlyA, onlyB };
}

/** The diff as text: a header, one line per differing event (every event with `all`), a summary. */
export function formatDiff(lines: DiffLine[], labels: { a: string; b: string }, opts: { all?: boolean } = {}): string {
  const shown = opts.all ? lines : lines.filter((l) => !l.same);
  const rows = shown.map((l) => [
    l.publishedAt ? l.publishedAt.slice(0, 16).replace("T", " ") : "-",
    l.headline.slice(0, 60) || l.newsId,
    cell(l.a),
    cell(l.b),
    l.note,
  ]);
  const s = summarizeDiff(lines);
  const head = `${labels.a}  vs  ${labels.b}: ${s.events} events, ${s.same} same, ${s.differ} differ` +
    (s.onlyA || s.onlyB ? ` (only in A: ${s.onlyA}, only in B: ${s.onlyB})` : "");
  if (rows.length === 0) return `${head}\n(no ${opts.all ? "events" : "differences"})`;
  const table = renderTable(["when", "event", `A: ${labels.a}`, `B: ${labels.b}`, "change"], rows, ["left", "left", "left", "left", "left"]);
  return `${head}\n\n${table}`;
}
