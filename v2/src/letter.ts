// SPDX-License-Identifier: MIT-0
/**
 * Pure text helpers for the daily letter. Kept out of `daily-report.ts` so
 * tests can import them without importing that module's entry point (which
 * would fire a real report run — AWS reads plus Fable spend — on import).
 */

/**
 * The letter's H1 is prepended deterministically, but the model usually opens
 * with a title of its own too (plus a bold pseudo-title). Drop leading
 * title-shaped lines so the printed page doesn't repeat its own headline.
 * Only strips at the very top, and only whole lines, so a real first section
 * heading and a bold lead-in mid-paragraph both survive.
 */
export function stripLeadingTitle(story: string): string {
  let s = story.trimStart();
  for (;;) {
    // An H1, a bold-only title line, or a single-line italic dateline
    // ("*Written Thursday morning, September 3, covering ...*") — the letterhead
    // already carries the title and the window, so all three are duplicates.
    const m = /^(?:# [^\n]*|\*\*[^\n]*\*\*[ \t]*|\*[^*\n]+\*[ \t]*|_[^_\n]+_[ \t]*)\n+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length).trimStart();
  }
  return s;
}

/**
 * LLM spend attributable to the letter's own reporting window, summed from the
 * per-investigation `cost_usd` recorded on each decision row.
 *
 * The budget breaker's `SPEND/DAY#<utc-date>` rows are bucketed by UTC day and
 * are the wrong base for this sentence: the letter covers a rolling 24h labelled
 * by LOCAL date, so any run after the UTC rollover reads a fresh row and reports
 * $0.00 — which is exactly what the Sep 1 letter had to correct in prose. Each
 * `addSpend()` call passes the same figure that lands on the decision row, so
 * summing the window is equivalent in kind and correct in extent.
 *
 * Scope, deliberately narrower than the breaker's tally: Haiku triage is never
 * metered, and replay-bench runs land under `BENCH#` keys the letter never scans.
 * Rows with no cost recorded are excluded from both the total and the count so
 * that cost-per-investigation stays honest.
 */
export function windowSpend(
  events: { cost?: number }[],
): { cost: number; investigations: number } {
  const priced = events.filter((e) => Number.isFinite(Number(e.cost)));
  return {
    cost: priced.reduce((s, e) => s + Number(e.cost), 0),
    investigations: priced.length,
  };
}

/** "Sep 2, 9:11 AM" in the machine's local zone (the letter is a local artifact). */
export function fmtLocal(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** "Wednesday, Sep 2, 5:58 PM" — the weekday spelled out so the model never infers it. */
export function fmtLocalWeekday(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** Short zone name for `now` ("EDT"). */
export function localZone(now: Date): string {
  return now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() ?? "";
}

/**
 * Human window label for the letter's letterhead and prompt. The job runs in the
 * MORNING (08:00 local), so what it covers is mostly *yesterday's* trading —
 * without saying so, the model narrates yesterday's fills as "today". The span
 * is stated as measured, not assumed: since the window is anchored on the
 * previous letter (see windowStart) it is rarely exactly 24 hours.
 */
export function windowLabel(sinceMs: number, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - sinceMs) / 3_600_000));
  return `the ${hours} hour${hours === 1 ? "" : "s"} from ${fmtLocalWeekday(new Date(sinceMs))} to ${fmtLocalWeekday(now)} ${localZone(now)}`;
}

/** Longest span one letter will cover; an older anchor is truncated, not silently absorbed. */
export const MAX_WINDOW_HOURS = 72;

export type WindowBasis = "rerun" | "previous-letter" | "previous-file" | "fallback-24h";

/**
 * Where this letter's window starts. The letters are the memory chain, so each
 * must begin exactly where the previous one ended. A fixed trailing 24h does
 * not: the 2026-09-02 letter re-told twelve hours of Sep 1 as fresh news (the
 * Texas fill, the NHC burst) because the Sep 1 letter had been run at 21:03,
 * and it then misread its own fill count trying to reconcile the overlap.
 *
 * Precedence: a rerun of the same day keeps that day's original start, so the
 * regenerated letter covers the same period; else the previous letter's
 * generation time; else the previous report file's mtime (bridges the first run
 * after this was introduced); else 24h. Anchors in the future or unparsable are
 * ignored. Capped at MAX_WINDOW_HOURS so a long outage yields a bounded letter.
 */
export function windowStart(opts: {
  nowMs: number;
  sameDayStartMs?: number | null;
  previousGeneratedMs?: number | null;
  previousFileMs?: number | null;
}): { sinceMs: number; basis: WindowBasis } {
  const cap = opts.nowMs - MAX_WINDOW_HOURS * 3_600_000;
  const pick = (ms: number | null | undefined, basis: WindowBasis) =>
    typeof ms === "number" && Number.isFinite(ms) && ms < opts.nowMs
      ? { sinceMs: Math.max(ms, cap), basis }
      : null;
  return (
    pick(opts.sameDayStartMs, "rerun") ??
    pick(opts.previousGeneratedMs, "previous-letter") ??
    pick(opts.previousFileMs, "previous-file") ??
    { sinceMs: opts.nowMs - 24 * 3_600_000, basis: "fallback-24h" }
  );
}

/**
 * Stretches inside the window with no processing at all — no triage, skip,
 * dedupe, alert or decision row of any kind. News arrives around the clock
 * (400+ items a day), so a multi-hour silence means the worker was down
 * (host asleep, expired AWS credentials, lost network), not that
 * nothing happened. The letter only ever saw the rows that exist; this turns
 * their absence into evidence, including silence at either edge of the window.
 */
export function coverageGaps(
  rowMs: number[],
  sinceMs: number,
  nowMs: number,
  minGapMs = 2 * 3_600_000,
): { fromMs: number; toMs: number }[] {
  const ts = [
    sinceMs,
    ...rowMs.filter((t) => t >= sinceMs && t <= nowMs).sort((a, b) => a - b),
    nowMs,
  ];
  const gaps: { fromMs: number; toMs: number }[] = [];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] >= minGapMs) gaps.push({ fromMs: ts[i - 1], toMs: ts[i] });
  }
  return gaps;
}

/**
 * Headline for a decision row that has none (rows before 2026-09-02 carry only
 * the agent's closing text). That text usually ends in a "**Summary:** ..." line
 * preceded by boilerplate ("Nothing further is needed — ..."), so prefer the
 * summary; otherwise the first line of whatever is there.
 */
export function summaryHeadline(summary: unknown, max = 100): string | undefined {
  if (summary === undefined || summary === null || summary === "") return undefined;
  const s = String(summary);
  const m = s.match(/\*\*Summary:?\*\*:?\s*([^\n]+)/);
  return (m ? m[1] : s.trim().split("\n")[0]).trim().slice(0, max) || undefined;
}

/** The slice of a triaged event the news-flow digest needs. */
export interface NewsFlowRow {
  /** ISO timestamp of the triage row (UTC). */
  at: string;
  headline: string;
  materiality: number;
  /** Triage judged it touches a held position. */
  touches?: boolean;
  /** Triage's event_type (disaster, macro, corporate, crypto, ...). */
  eventType?: string;
  /** Triage's one-paragraph rationale: what the news is and why it matters. */
  note?: string;
  /** Short outcome when it was investigated ("hold (watch X)", "buy Y $2000 FILLED"). */
  outcome?: string;
  /** Budget-breaker refusal reason when it was material but never investigated. */
  skipped?: string;
}

function headlineKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
}

/**
 * What happened in the world during the window — not just what the agent chose
 * to investigate. The appendix used to list investigated items only, so on a
 * low-investigation day (18 of 293 triaged on 2026-09-02) the letter had almost
 * no news to survey and the tape overview the principal reads for shrank to a
 * clause. Near-identical headlines collapse to one line with a count (NHC
 * advisory cycles, wire re-sends); the investigated one is kept, else the most
 * material. Sorted by materiality so the top of the list is the day's story.
 */
export function newsFlowLines(rows: NewsFlowRow[], max = 30): string[] {
  const out: string[] = [];
  if (rows.length === 0) return ["(nothing triaged in the window)"];

  const types = new Map<string, { n: number; inv: number }>();
  for (const r of rows) {
    const t = r.eventType || "other";
    const c = types.get(t) ?? { n: 0, inv: 0 };
    c.n++;
    if (r.outcome) c.inv++;
    types.set(t, c);
  }
  out.push(
    "by type (triaged/investigated): " +
      [...types]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([t, c]) => `${t} ${c.n}/${c.inv}`)
        .join(", "),
  );

  const byKey = new Map<string, { row: NewsFlowRow; n: number }>();
  for (const r of rows) {
    const k = headlineKey(r.headline);
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, { row: r, n: 1 });
      continue;
    }
    cur.n++;
    const better =
      (!!r.outcome && !cur.row.outcome) ||
      (!!r.outcome === !!cur.row.outcome && r.materiality > cur.row.materiality);
    if (better) cur.row = r;
  }
  const items = [...byKey.values()].sort(
    (a, b) => b.row.materiality - a.row.materiality || a.row.at.localeCompare(b.row.at),
  );
  for (const { row: r, n } of items.slice(0, max)) {
    const status = r.outcome
      ? `-> ${r.outcome}`
      : r.skipped
        ? `budget-skipped (${r.skipped})`
        : "not investigated";
    const note = r.note ? ` — ${r.note.replace(/\s+/g, " ").trim().slice(0, 220)}` : "";
    out.push(
      `- ${r.at.slice(5, 16)} [${r.eventType || "?"}] mat ${r.materiality}${r.touches ? "*" : ""} ` +
        `"${r.headline.slice(0, 90)}"${n > 1 ? ` x${n}` : ""} ${status}${note}`,
    );
  }
  if (items.length > max) {
    out.push(
      `  (+${items.length - max} more distinct headlines at materiality ${items[max].row.materiality} or below)`,
    );
  }
  return out;
}

/**
 * Bold-only lines become H2 headings so every letter renders the same way in
 * print and in the Word copy: the model alternates between "**The tape**" and
 * "## The tape" from one day to the next.
 */
export function normalizeHeadings(story: string): string {
  return story.replace(/^\*\*([^*\n]{2,80})\*\*[ \t]*$/gm, "## $1");
}

