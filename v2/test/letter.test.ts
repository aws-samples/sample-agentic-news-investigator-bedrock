// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  stripLeadingTitle,
  windowSpend,
  windowLabel,
  windowStart,
  coverageGaps,
  MAX_WINDOW_HOURS,
  summaryHeadline,
  newsFlowLines,
  normalizeHeadings,
  type NewsFlowRow,
} from "../src/letter.js";

describe("stripLeadingTitle", () => {
  it("drops the model's own H1 so the printed letter has one headline", () => {
    const out = stripLeadingTitle("# fin v2 daily letter — 2026-09-01\n\nThe scoreboard flipped.");
    expect(out).toBe("The scoreboard flipped.");
  });

  it("drops a bold pseudo-title line as well as an H1", () => {
    const out = stripLeadingTitle(
      "# fin v2 daily letter — 2026-09-01\n\n**fin v2 — Daily Letter, September 1**\n\nCash was $95,450.",
    );
    expect(out).toBe("Cash was $95,450.");
  });

  it("keeps a real first section heading and normal prose", () => {
    const story = "## The oil trade paid\n\nWTI went through ninety.";
    expect(stripLeadingTitle(story)).toBe(story);
  });

  it("drops a self-written italic dateline — the letterhead already states the window", () => {
    const out = stripLeadingTitle(
      "*Written Thursday morning, September 3, covering the 21 hours from Tuesday.*\n\n## The capital\n\nCash.",
    );
    expect(out).toBe("## The capital\n\nCash.");
    expect(stripLeadingTitle("_Covering Tuesday._\n\nCash.")).toBe("Cash.");
  });

  it("keeps a paragraph that merely opens with a bold lead-in", () => {
    const story = "**The scoreboard flipped today.** We lead the control by $1,638.";
    expect(stripLeadingTitle(story)).toBe(story);
  });
});

describe("windowSpend", () => {
  it("sums the window's own investigation costs rather than a UTC-day bucket", () => {
    const s = windowSpend([{ cost: 0.31 }, { cost: 0.22 }, { cost: 0.47 }]);
    expect(s.cost).toBeCloseTo(1.0, 6);
    expect(s.investigations).toBe(3);
  });

  it("ignores rows with no cost recorded, so cost-per-investigation stays honest", () => {
    const s = windowSpend([{ cost: 0.5 }, {}, { cost: undefined }, { cost: 0.5 }]);
    expect(s.cost).toBeCloseTo(1.0, 6);
    expect(s.investigations).toBe(2);
    expect(s.cost / s.investigations).toBeCloseTo(0.5, 6);
  });

  it("reports zero for a window with no investigations without dividing by zero", () => {
    const s = windowSpend([]);
    expect(s).toEqual({ cost: 0, investigations: 0 });
  });

  it("counts a genuinely free investigation, e.g. one that errored before billing", () => {
    const s = windowSpend([{ cost: 0 }, { cost: 0.4 }]);
    expect(s.cost).toBeCloseTo(0.4, 6);
    expect(s.investigations).toBe(2);
  });
});

describe("windowLabel", () => {
  it("names both ends of the window so a morning letter cannot pass yesterday off as today", () => {
    const now = new Date("2026-09-02T12:00:00Z"); // 08:00 EDT
    const label = windowLabel(now.getTime() - 24 * 3_600_000, now);
    expect(label).toMatch(/^the 24 hours from Tuesday, Sep 1, /);
    expect(label).toContain("to Wednesday, Sep 2, ");
    expect(label).toMatch(/\b(?:[A-Z]{2,4}|GMT[+-]\d{1,2}(?::\d\d)?)$/); // ends in a timezone abbr (or GMT±h where Intl has none)
  });

  it("spans a month boundary without losing the earlier date", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(windowLabel(now.getTime() - 24 * 3_600_000, now)).toContain("from Wednesday, Sep 30, ");
  });

  it("states the span it actually covers once anchored on the previous letter", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    expect(windowLabel(now.getTime() - 22.8 * 3_600_000, now)).toMatch(/^the 23 hours from /);
    expect(windowLabel(now.getTime() - 1 * 3_600_000, now)).toMatch(/^the 1 hour from /);
  });
});

describe("windowStart", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-09-03T12:00:00Z"); // 08:00 EDT run

  it("starts where the previous letter ended, not a fixed 24h back", () => {
    const prev = Date.parse("2026-09-02T13:11:00Z"); // yesterday's letter ran late, 9:11 EDT
    expect(windowStart({ nowMs: now, previousGeneratedMs: prev })).toEqual({
      sinceMs: prev,
      basis: "previous-letter",
    });
  });

  it("a rerun of the same day keeps that day's original start", () => {
    const start = Date.parse("2026-09-02T13:11:00Z");
    expect(
      windowStart({ nowMs: now, sameDayStartMs: start, previousGeneratedMs: now - 2 * H }),
    ).toEqual({ sinceMs: start, basis: "rerun" });
  });

  it("bridges the first anchored run with the previous report file's mtime", () => {
    const m = now - 20 * H;
    expect(windowStart({ nowMs: now, previousFileMs: m })).toEqual({
      sinceMs: m,
      basis: "previous-file",
    });
  });

  it("falls back to 24h when nothing is known", () => {
    expect(windowStart({ nowMs: now })).toEqual({ sinceMs: now - 24 * H, basis: "fallback-24h" });
  });

  it("caps a long silence at MAX_WINDOW_HOURS instead of swallowing a week", () => {
    const r = windowStart({ nowMs: now, previousGeneratedMs: now - 7 * 24 * H });
    expect(r.sinceMs).toBe(now - MAX_WINDOW_HOURS * H);
    expect(r.basis).toBe("previous-letter");
  });

  it("ignores an unparsable or future anchor", () => {
    expect(windowStart({ nowMs: now, previousGeneratedMs: NaN }).basis).toBe("fallback-24h");
    expect(windowStart({ nowMs: now, previousGeneratedMs: now + H }).basis).toBe("fallback-24h");
  });
});

describe("coverageGaps", () => {
  const H = 3_600_000;
  const since = Date.parse("2026-09-01T13:00:00Z");
  const now = since + 24 * H;

  it("finds every multi-hour silence between rows", () => {
    const rows = [since + 0.5 * H, since + 1 * H, since + 8 * H, since + 20 * H, since + 23.5 * H];
    expect(coverageGaps(rows, since, now, 2 * H)).toEqual([
      { fromMs: since + 1 * H, toMs: since + 8 * H },
      { fromMs: since + 8 * H, toMs: since + 20 * H },
      { fromMs: since + 20 * H, toMs: since + 23.5 * H },
    ]);
  });

  it("counts silence at the window edges too", () => {
    expect(coverageGaps([since + 12 * H], since, now, 2 * H)).toEqual([
      { fromMs: since, toMs: since + 12 * H },
      { fromMs: since + 12 * H, toMs: now },
    ]);
  });

  it("reports nothing while rows keep coming", () => {
    const rows = Array.from({ length: 48 }, (_, i) => since + i * 0.5 * H);
    expect(coverageGaps(rows, since, now, 2 * H)).toEqual([]);
  });

  it("ignores rows outside the window and tolerates unsorted input", () => {
    const rows = [now + H, since - H, since + 10 * H, since + 2 * H];
    expect(coverageGaps(rows, since, now, 3 * H)).toEqual([
      { fromMs: since + 2 * H, toMs: since + 10 * H },
      { fromMs: since + 10 * H, toMs: now },
    ]);
  });
});

describe("summaryHeadline", () => {
  it("prefers the agent's Summary line over its closing boilerplate", () => {
    const text =
      "Nothing further is needed — the decision is recorded and complete.\n\n" +
      "**Summary:** The -10.3% alert on WTI-$100 is spread, not thesis. Held at 0.6.\n\nMore.";
    expect(summaryHeadline(text)).toBe(
      "The -10.3% alert on WTI-$100 is spread, not thesis. Held at 0.6.",
    );
  });

  it("falls back to the first line and truncates", () => {
    expect(summaryHeadline("Held Texas.\nDetails follow.")).toBe("Held Texas.");
    expect(summaryHeadline("x".repeat(300))).toHaveLength(100);
  });

  it("returns undefined for nothing", () => {
    expect(summaryHeadline(undefined)).toBeUndefined();
    expect(summaryHeadline("")).toBeUndefined();
    expect(summaryHeadline("   \n")).toBeUndefined();
  });
});

describe("newsFlowLines", () => {
  const row = (o: Partial<NewsFlowRow> & { headline: string; materiality: number }): NewsFlowRow => ({
    at: "2026-09-02T11:29:00.000Z",
    eventType: "macro",
    ...o,
  });

  it("leads with the breakdown by type, then the most material headlines first", () => {
    const lines = newsFlowLines([
      row({ headline: "IRGC claims two tankers mined", materiality: 0.62, outcome: "buy WTI100 $2000 FILLED" }),
      row({ headline: "Hurricane Lowell advisory 26", materiality: 0.65, eventType: "disaster", touches: true, outcome: "hold (watch HE)" }),
      row({ headline: "ADP misses", materiality: 0.25, note: "Routine monthly release;   soft print." }),
    ]);
    expect(lines[0]).toBe("by type (triaged/investigated): macro 2/1, disaster 1/1");
    expect(lines[1]).toContain('[disaster] mat 0.65* "Hurricane Lowell advisory 26" -> hold (watch HE)');
    expect(lines[2]).toContain('"IRGC claims two tankers mined" -> buy WTI100 $2000 FILLED');
    expect(lines[3]).toContain('"ADP misses" not investigated — Routine monthly release; soft print.');
  });

  it("collapses near-identical headlines and keeps the investigated one", () => {
    const lines = newsFlowLines([
      row({ headline: "Summary for Hurricane Lowell (EP4/EP122026)", materiality: 0.9 }),
      row({ headline: "Summary for Hurricane Lowell (EP4/EP122026)", materiality: 0.65, outcome: "hold" }),
      row({ headline: "summary for hurricane lowell  (EP4/EP122026)", materiality: 0.7 }),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("x3 -> hold");
    expect(lines[1]).toContain("mat 0.65");
  });

  it("marks budget-skipped items and caps the list", () => {
    const rows = Array.from({ length: 35 }, (_, i) =>
      row({ headline: `headline ${i}`, materiality: 1 - i / 100, skipped: i === 0 ? "daily budget $50 spent" : undefined }),
    );
    const lines = newsFlowLines(rows, 30);
    expect(lines[1]).toContain("budget-skipped (daily budget $50 spent)");
    expect(lines).toHaveLength(1 + 30 + 1);
    expect(lines.at(-1)).toBe("  (+5 more distinct headlines at materiality 0.7 or below)");
  });

  it("says so when nothing was triaged", () => {
    expect(newsFlowLines([])).toEqual(["(nothing triaged in the window)"]);
  });
});

describe("normalizeHeadings", () => {
  it("turns bold-only lines into H2 so every letter prints alike", () => {
    const story = "Opening prose.\n\n**The tape**\n\nOil moved.\n\n## The threads\n\nStill open.";
    expect(normalizeHeadings(story)).toBe(
      "Opening prose.\n\n## The tape\n\nOil moved.\n\n## The threads\n\nStill open.",
    );
  });

  it("leaves a paragraph that merely opens with a bold lead-in alone", () => {
    const story = "**The scoreboard flipped.** We lead by $1,638.";
    expect(normalizeHeadings(story)).toBe(story);
  });
});
