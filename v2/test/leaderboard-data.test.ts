// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  buildLeaderboard,
  maxDrawdownPct,
  modelLabel,
  renderMarkdownTable,
  renderCompactTable,
  renderReadmeSection,
  renderLeaderboardReadme,
  renderEquitySvg,
  injectSection,
  armBadge,
  leaderBadge,
  README_START,
  README_END,
  type ArmInput,
} from "../src/leaderboard-data.js";
import type { Arm } from "../src/books.js";
import type { CurveSeries, ScoreRow } from "../src/dashboard-data.js";

const NOW = "2026-09-19T12:00:00Z";

function arm(over: Partial<Arm> & { key: Arm["key"] }): Arm {
  return {
    label: over.key,
    kind: over.key === "v1" ? "pipeline" : "agent",
    worldModel: over.key === "v3",
    role: over.key === "v1" ? "identity" : over.key === "v2" ? "focus" : "arm",
    table: `fin-${over.key}`,
    seed: 100_000,
    equity: 100_000,
    cash: 100_000,
    positionsValue: 0,
    realized: 0,
    unrealized: 0,
    returnPct: 0,
    inceptionIso: "2026-08-30T20:54:43Z",
    fills: 0,
    buyNotional: 0,
    positions: [],
    snapshots: [],
    ...over,
  };
}

const scores = (n1d: number, p1d: number, n7d = 0, p7d = 0): ScoreRow[] => [
  { group: "trades", horizon: "1h", n: 0, meanPct: 0, positivePct: 0, rightPct: 0 },
  { group: "trades", horizon: "1d", n: n1d, meanPct: 0.4, positivePct: p1d, rightPct: p1d },
  { group: "trades", horizon: "7d", n: n7d, meanPct: 0.1, positivePct: p7d, rightPct: p7d },
  { group: "holds", horizon: "1d", n: 40, meanPct: 0, positivePct: 50, rightPct: 50 },
];

const v2 = arm({
  key: "v2",
  label: "v2 investigator",
  equity: 116_049,
  returnPct: 16.049,
  realized: 15_053,
  unrealized: 996,
  fills: 120,
  snapshots: [
    { day: "2026-09-02", equity: 100_500 },
    { day: "2026-09-08", equity: 104_000 },
    { day: "2026-09-10", equity: 101_000 }, // dip after the 104k peak: 2.88% drawdown
    { day: "2026-09-15", equity: 112_000 },
  ],
});
const v3 = arm({ key: "v3", label: "v3 world model", inceptionIso: "2026-09-08T00:00:00Z", equity: 105_200, returnPct: 5.2, fills: 40, snapshots: [{ day: "2026-09-10", equity: 102_000 }] });
const v1 = arm({ key: "v1", label: "v1 pipeline (control)", inceptionIso: "2026-08-28T00:00:00Z", equity: 100_060, returnPct: 0.06, fills: 3, snapshots: [{ day: "2026-09-08", equity: 100_020 }] });

const inputs: ArmInput[] = [
  { arm: v1, model: "Sonnet 4.6 · gate", design: "pipeline", spendUsd: null, scores: [], spyReturnPct: -1.5 },
  { arm: v3, model: "Fable 5.1 · world model", design: "world", spendUsd: 400, scores: scores(12, 58), spyReturnPct: -0.5 },
  { arm: v2, model: "Fable 5.1 · Agent SDK", design: "agent", spendUsd: 1200.5, scores: scores(60, 55, 31, 61), spyReturnPct: -1.99 },
];

const curve: CurveSeries[] = [
  { key: "v2", label: "v2 investigator", role: "focus", points: [{ tMs: 1, value: 100_000 }, { tMs: 2, value: 116_049 }] },
  { key: "v3", label: "v3 world model", role: "arm", points: [{ tMs: 1, value: 100_000 }, { tMs: 2, value: 105_200 }] },
  { key: "SPY", label: "SPY", role: "context", points: [{ tMs: 1, value: 100_000 }, { tMs: 2, value: 98_010 }] },
  { key: "one-point", label: "x", role: "identity", points: [{ tMs: 1, value: 1 }] },
];

describe("buildLeaderboard", () => {
  const lb = buildLeaderboard({ generatedAtIso: NOW, arms: inputs, curve, benchmarks: [{ symbol: "SPY", label: "S&P 500", returnPct: -1.99 }] });

  it("ranks by return on seed and numbers the ranks", () => {
    expect(lb.rows.map((r) => [r.rank, r.key])).toEqual([[1, "v2"], [2, "v3"], [3, "v1"]]);
  });

  it("measures excess over SPY on each arm's own window", () => {
    const r = lb.rows.find((x) => x.key === "v2")!;
    expect(r.excessPct).toBeCloseTo(16.049 + 1.99, 5);
  });

  it("uses the youngest inception as the common start and rebases from the first snapshot after it", () => {
    expect(lb.commonStartIso).toBe("2026-09-08T00:00:00Z");
    const r2 = lb.rows.find((x) => x.key === "v2")!;
    expect(r2.sinceCommonPct).toBeCloseTo(((116_049 - 104_000) / 104_000) * 100, 6); // first v2 snapshot on/after 09-08
    const r3 = lb.rows.find((x) => x.key === "v3")!;
    expect(r3.sinceCommonPct).toBeCloseTo(5.2, 6); // youngest arm: its own seed is the base
  });

  it("computes drawdown over seed, snapshots and the live mark", () => {
    const r2 = lb.rows.find((x) => x.key === "v2")!;
    expect(r2.maxDrawdownPct).toBeCloseTo(((104_000 - 101_000) / 104_000) * 100, 6);
    expect(maxDrawdownPct([100, 120, 90, 130])).toBeCloseTo(25, 6);
    expect(maxDrawdownPct([100, 101, 102])).toBe(0);
  });

  it("reports hit rates only where trades were scored, and P&L per LLM dollar only when metered", () => {
    const r2 = lb.rows.find((x) => x.key === "v2")!;
    expect(r2.hit1d).toEqual({ n: 60, pct: 55 });
    expect(r2.hit7d).toEqual({ n: 31, pct: 61 });
    expect(r2.pnlPerSpendDollar).toBeCloseTo(16_049 / 1200.5, 6);
    const r3 = lb.rows.find((x) => x.key === "v3")!;
    expect(r3.hit7d).toBeNull();
    const r1 = lb.rows.find((x) => x.key === "v1")!;
    expect(r1.hit1d).toBeNull();
    expect(r1.spendUsd).toBeNull();
    expect(r1.pnlPerSpendDollar).toBeNull();
    expect(r1.days).toBe(22);
  });

  it("carries the caveats", () => {
    expect(lb.caveats.length).toBeGreaterThanOrEqual(3);
    expect(lb.caveats.join(" ")).toMatch(/Paper trading/);
  });
});

describe("rendering", () => {
  const lb = buildLeaderboard({ generatedAtIso: NOW, arms: inputs, curve, benchmarks: [{ symbol: "SPY", label: "S&P 500", returnPct: -1.99 }] });

  it("renders a full markdown table with one row per arm and the leader first", () => {
    const md = renderMarkdownTable(lb);
    const rows = md.split("\n").slice(2);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("**v2 investigator**");
    expect(rows[0]).toContain("**+16.05%**");
    expect(rows[0]).toContain("+18.04 pp");
    expect(rows[0]).toContain("55% (n=60)");
    expect(rows[2]).toContain("| — |"); // v1 has no spend
  });

  it("renders the compact README block between markers with the chart and caveat link", () => {
    const block = renderReadmeSection(lb, { svgPath: "leaderboard/equity.svg", detailPath: "leaderboard/README.md" });
    expect(block.startsWith(README_START)).toBe(true);
    expect(block.endsWith(README_END)).toBe(true);
    expect(block).toContain("![Equity since inception](leaderboard/equity.svg)");
    expect(block).toContain("leading: **v2 investigator** at +16.05%");
    expect(renderCompactTable(lb).split("\n")).toHaveLength(5);
  });

  it("renders the detail README with caveats and benchmarks", () => {
    const md = renderLeaderboardReadme(lb, { svgFile: "equity.svg" });
    expect(md).toContain("# fin leaderboard");
    expect(md).toContain("SPY −1.99%".replace("−", "-") === "SPY -1.99%" ? "SPY -1.99%" : "SPY -1.99%");
    expect(md).toContain("## Read this before drawing conclusions");
    expect(md).toContain("Common start: 2026-09-08");
  });

  it("injects into a README: replaces between markers, or inserts before Pipeline the first time", () => {
    const block = `${README_START}\nNEW\n${README_END}`;
    const fresh = "# fin\n\nintro\n\n## Pipeline\n\nstuff\n";
    const once = injectSection(fresh, block);
    expect(once).toContain("## Leaderboard\n\n" + block);
    expect(once.indexOf("## Leaderboard")).toBeLessThan(once.indexOf("## Pipeline"));
    const twice = injectSection(once.replace("NEW", "OLD"), block);
    expect(twice).toBe(once);
    expect(twice.match(/leaderboard:start/g)).toHaveLength(1);
    const noPipeline = injectSection("# x\n", block);
    expect(noPipeline.endsWith(`## Leaderboard\n\n${block}\n\n`)).toBe(true);
  });

  it("builds shields.io badges", () => {
    const b = armBadge(lb.rows[0]);
    expect(b).toEqual({ schemaVersion: 1, label: "fin v2 · Fable 5.1", message: "+16.05% on seed · $116,049", color: "brightgreen" });
    expect(leaderBadge(lb).message).toBe("v2 investigator leads · +16.05%");
    expect(armBadge({ ...lb.rows[0], returnPct: -2 }).color).toBe("red");
  });

  it("renders an SVG with one path per drawable series, a seed line and escaped text", () => {
    const svg = renderEquitySvg(curve, { seed: 100_000, generatedAtIso: NOW, title: 'a<b>&"c' });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.match(/<path /g)).toHaveLength(3); // the one-point series is skipped
    expect(svg).toContain('data-series="SPY"');
    expect(svg).toContain('stroke-dasharray="4 4"'); // seed baseline
    expect(svg).toContain("a&lt;b&gt;&amp;&quot;c");
    expect(svg).not.toContain("<script");
    expect(renderEquitySvg([], {})).toContain("not enough points yet");
  });
});

describe("modelLabel", () => {
  it("prettifies short model ids", () => {
    expect(modelLabel("fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelLabel("opus")).toBe("Opus");
  });
});
