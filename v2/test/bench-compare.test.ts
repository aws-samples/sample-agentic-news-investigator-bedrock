// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  corpusKey,
  diffRecord,
  diffRuns,
  filterSummaries,
  formatCompareTable,
  formatDiff,
  latestPerPk,
  parseRunSelectors,
  recordsFrom,
  renderTable,
  runKeyOf,
  sameCorpus,
  shortHash,
  summariesFrom,
  summaryFrom,
  summarizeDiff,
  type AuditItem,
  type BenchSummary,
} from "../src/bench/compare.js";

// Pure formatting over fixture rows shaped exactly as replay.ts writes them.
// Nothing here reads DynamoDB.

const FILE_HASH = "9f2c4d6e8a1b3c5d7e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d";  // pragma: allowlist secret
const ITEMS_HASH = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_ITEMS = "2222222222222222222222222222222222222222222222222222222222222222";

function benchsum(name: string, variant: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pk: "BENCHSUM",
    sk: `${name}#${variant}`,
    bench: name,
    variant,
    arm: "v2",
    input: "corpus",
    corpus_file: "bench/corpus/w36.jsonl",
    corpus_hash: FILE_HASH,
    corpus_items_hash: ITEMS_HASH,
    window: "2026-08-17T00:00:00.000Z..2026-08-29T00:00:00.000Z",
    window_days: 12,
    events_seen: 60,
    triage_passed: 9,
    decided: 8,
    buys: 2,
    sells: 1,
    holds: 5,
    errored: 1,
    filled: 2,
    dropped: 1,
    unscoreable: 1,
    cost_usd: 3.2,
    trade_mean_ret_1d: 0.0123,
    trade_mean_ret_7d: -0.045,
    hold_counterfactual_ret_1d: 0.002,
    triage_threshold: 0.45,
    book: { seed_cash: 100_000, final_equity: 101_250, return_on_seed: 0.0125 },
    stopped_reason: null,
    ran_at: "2026-09-11T10:00:00.000Z",
    ...over,
  };
}

describe("summaryFrom / summariesFrom", () => {
  it("shapes a BENCHSUM row, deriving cost per decision and the book figures", () => {
    const s = summaryFrom(benchsum("bench-a", "live"));
    expect(s).toMatchObject({
      name: "bench-a",
      variant: "live",
      runKey: "bench-a#live",
      arm: "v2",
      input: "corpus",
      corpusHash: FILE_HASH,
      corpusItemsHash: ITEMS_HASH,
      eventsSeen: 60,
      triagePassed: 9,
      decided: 8,
      buys: 2,
      sells: 1,
      holds: 5,
      errored: 1,
      filled: 2,
      dropped: 1,
      unscoreable: 1,
      costUsd: 3.2,
      tradeMeanRet1d: 0.0123,
      holdCounterfactualRet1d: 0.002,
      finalEquity: 101_250,
      returnOnSeed: 0.0125,
      threshold: 0.45,
    });
    expect(s.costPerDecision).toBeCloseTo(0.4, 10);
  });

  it("tolerates a legacy row (no arm/input/corpus fields, sk only) and null returns", () => {
    const legacy = {
      pk: "BENCHSUM",
      sk: "bench-old#terse",
      events_seen: 10,
      decided: 0,
      cost_usd: 0.5,
      trade_mean_ret_1d: null,
      ran_at: "2026-09-01T00:00:00.000Z",
    };
    const s = summaryFrom(legacy);
    expect(s).toMatchObject({ name: "bench-old", variant: "terse", arm: null, input: null, corpusHash: null, corpusItemsHash: null, tradeMeanRet1d: null, costPerDecision: null, finalEquity: null });
    expect(corpusKey(s)).toBeNull();
  });

  it("groups rows by corpus, then oldest run first, legacy rows last", () => {
    const rows = summariesFrom([
      benchsum("z-legacy", "live", { corpus_hash: null, corpus_items_hash: null, ran_at: "2026-08-01T00:00:00.000Z" }),
      benchsum("bench-b", "live", { ran_at: "2026-09-11T11:00:00.000Z" }),
      benchsum("arch-1", "live", { input: "archive", corpus_file: null, corpus_hash: null, corpus_items_hash: OTHER_ITEMS, ran_at: "2026-09-10T00:00:00.000Z" }),
      benchsum("bench-a", "live", { ran_at: "2026-09-11T10:00:00.000Z" }),
      benchsum("bench-a", "no-mandate", { ran_at: "2026-09-11T10:00:00.000Z" }),
    ]);
    expect(rows.map((r) => r.runKey)).toEqual(["arch-1#live", "bench-a#live", "bench-a#no-mandate", "bench-b#live", "z-legacy#live"]);
  });
});

describe("selectors", () => {
  const rows = summariesFrom([benchsum("bench-a", "live"), benchsum("bench-a", "terse"), benchsum("bench-b", "live")]);

  it("parseRunSelectors splits, trims and dedupes", () => {
    expect(parseRunSelectors(" bench-a, bench-b#live ,bench-a,")).toEqual(["bench-a", "bench-b#live"]);
    expect(parseRunSelectors(undefined)).toEqual([]);
  });

  it("a bare name matches every variant; name#variant exactly one; no selectors keeps all", () => {
    expect(filterSummaries(rows, ["bench-a"]).map((r) => r.runKey)).toEqual(["bench-a#live", "bench-a#terse"]);
    expect(filterSummaries(rows, ["bench-a#terse", "bench-b"]).map((r) => r.runKey)).toEqual(["bench-a#terse", "bench-b#live"]);
    expect(filterSummaries(rows, []).length).toBe(3);
    expect(filterSummaries(rows, ["nope"])).toEqual([]);
  });

  it("runKeyOf defaults the variant to live", () => {
    expect(runKeyOf("bench-a")).toEqual({ name: "bench-a", variant: "live", runKey: "bench-a#live" });
    expect(runKeyOf("bench-a#no-mandate")).toEqual({ name: "bench-a", variant: "no-mandate", runKey: "bench-a#no-mandate" });
    expect(runKeyOf("bench-a#")).toEqual({ name: "bench-a", variant: "live", runKey: "bench-a#live" });
  });
});

describe("sameCorpus", () => {
  const s = (corpusHash: string | null, corpusItemsHash: string | null) => ({ corpusHash, corpusItemsHash });

  it("matches on the items hash, and refuses when the files disagree", () => {
    expect(sameCorpus(s(FILE_HASH, ITEMS_HASH), s(FILE_HASH, ITEMS_HASH))).toBe(true);
    // archive run vs a corpus dumped from the same window: same canonical items
    expect(sameCorpus(s(null, ITEMS_HASH), s(FILE_HASH, ITEMS_HASH))).toBe(true);
    // same file, one run truncated by --max-events
    expect(sameCorpus(s(FILE_HASH, ITEMS_HASH), s(FILE_HASH, OTHER_ITEMS))).toBe(false);
    // same items, files that differ (e.g. edited header)? items win unless both files are known and differ
    expect(sameCorpus(s(FILE_HASH, ITEMS_HASH), s("ffff", ITEMS_HASH))).toBe(false);
  });

  it("falls back to the file hash for rows without an items hash and never matches unrecorded inputs", () => {
    expect(sameCorpus(s(FILE_HASH, null), s(FILE_HASH, null))).toBe(true);
    expect(sameCorpus(s(FILE_HASH, null), s("ffff", null))).toBe(false);
    expect(sameCorpus(s(null, null), s(null, null))).toBe(false);
    expect(sameCorpus(s(FILE_HASH, ITEMS_HASH), s(null, null))).toBe(false);
  });
});

describe("formatCompareTable", () => {
  it("prints an aligned table with the documented columns and a rule under the header", () => {
    const rows = summariesFrom([
      benchsum("bench-a", "live"),
      benchsum("bench-a", "no-mandate", { buys: 5, sells: 0, holds: 3, decided: 8, errored: 0, cost_usd: 4, trade_mean_ret_1d: -0.0021, trade_mean_ret_7d: null, hold_counterfactual_ret_1d: null }),
      benchsum("arch-1", "live", { arm: "v3", input: "archive", corpus_file: null, corpus_hash: null, corpus_items_hash: OTHER_ITEMS, decided: 0, cost_usd: 0 }),
    ]);
    const out = formatCompareTable(rows);
    const lines = out.split("\n");
    const header = lines[0];
    for (const col of ["arm", "run", "input", "corpus", "ran", "seen", "passed", "decided", "buy/sell/hold", "filled", "dropped", "mean 1d", "mean 7d", "hold cf 1d", "unscoreable", "cost", "cost/decision"]) {
      expect(header).toContain(col);
    }
    expect(lines[1]).toMatch(/^-+(  -+)+$/);
    // Column boundaries: every body row is the header's width (ignoring trailing trim) and columns align.
    const runCol = header.indexOf("run");
    expect(lines[2].slice(runCol)).toMatch(/^arch-1#live/);
    expect(lines[3].slice(runCol)).toMatch(/^bench-a#live/);
    expect(lines[4].slice(runCol)).toMatch(/^bench-a#no-mandate/);
    // Content.
    expect(lines[2]).toContain("v3");
    expect(lines[2]).toContain("archive");
    expect(lines[2]).toContain(OTHER_ITEMS.slice(0, 12));
    expect(lines[2]).toContain("n/a"); // cost per decision with 0 decided
    expect(lines[3]).toContain(FILE_HASH.slice(0, 12));
    expect(lines[3]).toContain("2026-09-11");
    expect(lines[3]).toContain("2/1/5");
    expect(lines[3]).toContain("8 (+1 err)");
    expect(lines[3]).toContain("1.23%");
    expect(lines[3]).toContain("-4.50%");
    expect(lines[3]).toContain("0.20%");
    expect(lines[3]).toContain("$3.20");
    expect(lines[3]).toContain("$0.40");
    expect(lines[4]).toContain("5/0/3");
    expect(lines[4]).toContain("-0.21%");
    expect(lines[4]).toContain("$0.50");
    // Footnotes explain the corpus column.
    expect(out).toContain("sha256 prefix");
  });

  it("says so when there is nothing to show", () => {
    expect(formatCompareTable([])).toBe("(no BENCHSUM rows)");
  });

  it("renderTable right-aligns numeric columns", () => {
    const t = renderTable(["name", "n"], [["a", "1"], ["bbb", "100"]], ["left", "right"]);
    expect(t.split("\n")).toEqual(["name    n", "----  ---", "a       1", "bbb   100"]);
  });

  it("shortHash", () => {
    expect(shortHash(FILE_HASH)).toBe("9f2c4d6e8a1b");  // pragma: allowlist secret
    expect(shortHash(null)).toBe("-");
  });
});

// ---------------------------------------------------------------------------
// Per-event diff from BENCH# audit rows
// ---------------------------------------------------------------------------

function audit(pk: string, stage: "bench-triage" | "bench-decision", payload: Record<string, unknown>, ts = "2026-09-11T10:00:00.000Z"): AuditItem {
  return { pk, sk: `EVT#${ts}#${stage}`, stage, payload };
}

const hold = (watch_symbol?: string) => ({ action: "hold", confidence: 0.6, rationale: "r", evidence: [], ...(watch_symbol ? { watch_symbol } : {}) });
const buy = (symbol: string, notional_usd: number) => ({ action: "buy", symbol, kind: "equity", notional_usd, confidence: 0.65, rationale: "r", evidence: [] });

function fixtureAudits(): AuditItem[] {
  const N = "bench-a";
  return [
    // Triage rows (shared by the name's variants), out of chronological order on purpose.
    audit(`BENCH#${N}#e3`, "bench-triage", { headline: "third", published_at: "2026-08-20T01:55:00Z", source_family: "disaster", materiality: 0.7 }),
    audit(`BENCH#${N}#e1`, "bench-triage", { headline: "first", published_at: "2026-08-17T03:14:22Z", source_family: "disaster", materiality: 0.62 }),
    audit(`BENCH#${N}#e2`, "bench-triage", { headline: "second", published_at: "2026-08-18T09:02:00Z", source_family: "edgar", materiality: 0.2 }),
    audit(`BENCH#${N}#e4`, "bench-triage", { headline: "fourth", published_at: "2026-08-21T06:33:00Z", source_family: "disaster", materiality: 0.5 }),
    // live: e1 buy filled, e3 hold, e4 errored. An older duplicate decision for e1 must lose to the newer one.
    audit(`BENCH#${N}#live#e1`, "bench-decision", { variant: "live", decisions: [hold("SPY")], outcomes: [{ action_id: "e1", action: "hold" }], cost_usd: 0.3, errored: false, headline: "first" }, "2026-09-10T00:00:00.000Z"),
    audit(`BENCH#${N}#live#e1`, "bench-decision", {
      variant: "live",
      decisions: [hold("QQQ"), buy("EWJ", 2000)],
      outcomes: [{ action_id: "e1#1", action: "hold" }, { action_id: "e1#2", action: "buy", symbol: "EWJ", status: "filled", fill: { side: "buy", qty: 28, fillPrice: 71.2, notionalUsd: 1993.6 } }],
      cost_usd: 0.41,
      ret_1d: 0.012,
      ret_7d: 0.03,
      scoreable: true,
      errored: false,
      headline: "first",
    }),
    audit(`BENCH#${N}#live#e3`, "bench-decision", { variant: "live", decisions: [hold("CL=F")], outcomes: [{ action_id: "e3", action: "hold", watch_symbol: "CL=F" }], cost_usd: 0.35, ret_1d: -0.004, ret_7d: null, scoreable: true, errored: false, headline: "third" }),
    audit(`BENCH#${N}#live#e4`, "bench-decision", { variant: "live", errored: true, cost_usd: 0.2, headline: "fourth" }),
    // no-mandate: e1 hold, e3 sell dropped, e4 not investigated (stopped).
    audit(`BENCH#${N}#no-mandate#e1`, "bench-decision", { variant: "no-mandate", decisions: [hold("EWJ")], outcomes: [{ action_id: "e1", action: "hold", watch_symbol: "EWJ" }], cost_usd: 0.3, ret_1d: 0.012, errored: false, headline: "first" }),
    audit(`BENCH#${N}#no-mandate#e3`, "bench-decision", {
      variant: "no-mandate",
      decisions: [{ ...buy("CL=F", 1500), action: "sell" }],
      outcomes: [{ action_id: "e3", action: "sell", symbol: "CL=F", status: "dropped", reason: "dropped_stale_quote" }],
      cost_usd: 0.5,
      errored: false,
      headline: "third",
    }),
    // Another bench under a similar name must not leak in (prefix ends with '#').
    audit(`BENCH#${N}-2#e1`, "bench-triage", { headline: "other bench", materiality: 0.9 }),
    audit(`BENCH#${N}-2#live#e1`, "bench-decision", { variant: "live", decisions: [buy("XXX", 1)], outcomes: [], cost_usd: 1, errored: false }),
  ];
}

describe("recordsFrom", () => {
  it("keeps the newest audit row per pk", () => {
    const m = latestPerPk(fixtureAudits());
    const e1 = m.get("BENCH#bench-a#live#e1")!;
    expect(e1.sk).toBe("EVT#2026-09-11T10:00:00.000Z#bench-decision");
  });

  it("joins one variant's decisions onto the shared triage rows and ignores other variants and other benches", () => {
    const live = recordsFrom(fixtureAudits(), { name: "bench-a", variant: "live" }, 0.45);
    expect([...live.keys()].sort()).toEqual(["e1", "e2", "e3", "e4"]);
    expect(live.get("e1")).toMatchObject({
      headline: "first",
      publishedAt: "2026-08-17T03:14:22Z",
      sourceFamily: "disaster",
      materiality: 0.62,
      passed: true,
      investigated: true,
      errored: false,
      action: "buy", // the primary action is the first trade, not the hold
      symbol: "EWJ",
      confidence: 0.65,
      notionalUsd: 2000,
      outcome: "filled 28 @ 71.2",
      ret1d: 0.012,
      ret7d: 0.03,
      costUsd: 0.41,
      numActions: 2,
    });
    expect(live.get("e2")).toMatchObject({ investigated: false, passed: false, materiality: 0.2, action: null, costUsd: 0 });
    expect(live.get("e3")).toMatchObject({ investigated: true, action: "hold", symbol: "CL=F", outcome: "hold", ret1d: -0.004, ret7d: null });
    expect(live.get("e4")).toMatchObject({ investigated: false, errored: true, costUsd: 0.2, passed: true });

    const nm = recordsFrom(fixtureAudits(), { name: "bench-a", variant: "no-mandate" }, 0.45);
    expect(nm.get("e1")).toMatchObject({ action: "hold", symbol: "EWJ", outcome: "hold" });
    expect(nm.get("e3")).toMatchObject({ action: "sell", symbol: "CL=F", outcome: "dropped: dropped_stale_quote", notionalUsd: 1500 });
    expect(nm.get("e4")).toMatchObject({ investigated: false, errored: false, passed: true });
  });

  it("leaves passed null when the run's threshold is unknown", () => {
    const live = recordsFrom(fixtureAudits(), { name: "bench-a", variant: "live" }, null);
    expect(live.get("e2")!.passed).toBeNull();
  });
});

describe("diffRuns / formatDiff", () => {
  const live = recordsFrom(fixtureAudits(), { name: "bench-a", variant: "live" }, 0.45);
  const nm = recordsFrom(fixtureAudits(), { name: "bench-a", variant: "no-mandate" }, 0.45);

  it("compares states per event in event order", () => {
    const lines = diffRuns(live, nm);
    expect(lines.map((l) => l.newsId)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(lines.map((l) => l.same)).toEqual([false, true, false, false]);
    expect(lines[0].note).toBe("buy EWJ -> hold EWJ");
    expect(lines[1].note).toBe("same");
    expect(lines[2].note).toBe("hold CL=F -> sell CL=F");
    expect(lines[3].note).toBe("errored -> not-investigated");
    expect(summarizeDiff(lines)).toEqual({ events: 4, same: 1, differ: 3, onlyA: 0, onlyB: 0 });
  });

  it("diffRecord treats absence, triage failure and matching actions correctly", () => {
    const a = live.get("e1")!;
    expect(diffRecord(a, { ...a, symbol: "ewj" })).toEqual({ same: true, note: "same" });
    expect(diffRecord(a, null)).toEqual({ same: false, note: "buy EWJ -> absent" });
    expect(diffRecord(live.get("e2")!, live.get("e2")!)).toEqual({ same: true, note: "same" });
    expect(diffRecord(live.get("e2")!, { ...live.get("e2")!, passed: null })).toEqual({ same: false, note: "triage-failed -> not-investigated" });
  });

  it("counts events present in only one run and orders undated events last", () => {
    const b = new Map(nm);
    b.delete("e4");
    b.set("zz", { ...nm.get("e1")!, newsId: "zz", publishedAt: null, headline: "undated" });
    const lines = diffRuns(live, b);
    expect(lines.map((l) => l.newsId)).toEqual(["e1", "e2", "e3", "e4", "zz"]);
    expect(summarizeDiff(lines)).toMatchObject({ onlyA: 1, onlyB: 1 });
  });

  it("formats only the differences by default, everything with --all, with a summary header", () => {
    const lines = diffRuns(live, nm);
    const out = formatDiff(lines, { a: "bench-a#live", b: "bench-a#no-mandate" });
    expect(out.split("\n")[0]).toBe("bench-a#live  vs  bench-a#no-mandate: 4 events, 1 same, 3 differ");
    expect(out).toContain("A: bench-a#live");
    expect(out).toContain("B: bench-a#no-mandate");
    expect(out).toContain("2026-08-17 03:14  first");
    expect(out).toContain("buy EWJ c0.65 $2000 | filled 28 @ 71.2 1d 1.20%");
    expect(out).toContain("hold EWJ c0.60 | hold 1d 1.20%");
    expect(out).toContain("sell CL=F c0.65 $1500 | dropped: dropped_stale_quote");
    expect(out).toContain("errored");
    expect(out).toContain("not investigated");
    expect(out).not.toContain("second"); // the identical event is hidden
    const all = formatDiff(lines, { a: "A", b: "B" }, { all: true });
    expect(all).toContain("second");
    expect(all).toContain("triage 0.2");
  });

  it("says when there is nothing to show", () => {
    expect(formatDiff(diffRuns(live, live), { a: "x", b: "x" })).toBe("x  vs  x: 4 events, 4 same, 0 differ\n(no differences)");
    expect(formatDiff([], { a: "x", b: "y" }, { all: true })).toBe("x  vs  y: 0 events, 0 same, 0 differ\n(no events)");
  });
});

describe("BenchSummary type is what the table needs", () => {
  it("tableRow never throws on a fully-null summary", () => {
    const s: BenchSummary = summaryFrom({ sk: "n#v" });
    expect(formatCompareTable([s])).toContain("n#v");
  });
});
