// SPDX-License-Identifier: MIT-0
/**
 * Leaderboard: the three arms ranked as three model configurations on the same
 * news. Pure shaping and rendering — no AWS, no clock — so it is unit-tested
 * from fixtures; `leaderboard.ts` gathers the inputs and writes the files.
 *
 * What is compared, and why each column exists:
 * - return on seed: the headline number, equity marked at liquidation value
 *   against the cash each arm started with;
 * - vs SPY over the arm's OWN window: arms started on different days, so a raw
 *   return is not comparable; the excess over SPY from each inception is;
 * - since common start: every arm measured from the youngest arm's inception,
 *   the one window where all three saw the same tape;
 * - max drawdown, fills, hit rates at 1d/7d (share of trades with a positive
 *   signed return; holds are scored separately and not shown), LLM spend and
 *   paper P&L per dollar of LLM spend — the cost side of "which model".
 *
 * Everything here is paper trading with small samples. The caveats are part of
 * the output, not a footnote, so every rendering carries them.
 */
import type { Arm, BenchmarkView } from "./books.js";
import type { CurveSeries, ScoreRow } from "./dashboard-data.js";

export interface ArmInput {
  arm: Arm;
  /** Human model label, e.g. "Fable 5.1 · Agent SDK · Haiku 4.5 triage". */
  model: string;
  /** One line on the decision design (gate or no gate, mandate, world model). */
  design: string;
  /** Bedrock spend to date in USD, or null when the arm does not meter it. */
  spendUsd: number | null;
  /** Outcome scores (dashboard-data `scoreRows`); empty when unscored. */
  scores: ScoreRow[];
  /** SPY total return over this arm's own window (its inception → now). */
  spyReturnPct: number | null;
}

export interface LeaderboardInput {
  generatedAtIso: string;
  arms: ArmInput[];
  curve: CurveSeries[];
  /** Benchmarks since the v2 inception, as the dashboard shows them. */
  benchmarks: BenchmarkView[];
}

export interface HitRate {
  n: number;
  /** Share of scored trades whose signed return at the horizon was positive, 0–100. */
  pct: number;
}

export interface LeaderboardRow {
  rank: number;
  key: string;
  label: string;
  model: string;
  design: string;
  inceptionIso: string | null;
  days: number;
  seed: number;
  equity: number;
  returnPct: number;
  spyReturnPct: number | null;
  /** Percentage points over SPY on the arm's own window. */
  excessPct: number | null;
  /** Return from the youngest arm's inception; null when snapshots do not reach it. */
  sinceCommonPct: number | null;
  maxDrawdownPct: number;
  fills: number;
  positions: number;
  realized: number;
  unrealized: number;
  hit1d: HitRate | null;
  hit7d: HitRate | null;
  spendUsd: number | null;
  /** Total paper P&L divided by LLM spend; null when spend is unknown or zero. */
  pnlPerSpendDollar: number | null;
}

export interface Leaderboard {
  generatedAtIso: string;
  commonStartIso: string | null;
  rows: LeaderboardRow[];
  benchmarks: BenchmarkView[];
  caveats: string[];
}

export const CAVEATS = [
  "Paper trading only: fills are simulated at liquidation value (bid for longs, ask for shorts) with a 2 bps adverse fill and a 25% cap on visible depth. There is no broker.",
  "Arms started on different days. \"Return on seed\" and \"vs SPY\" use each arm's own window; \"since common start\" measures every arm from the youngest arm's inception.",
  "Small samples. Hit rates with fewer than 30 scored trades are noise; a week of returns says little about a decision design.",
  "LLM spend is metered Bedrock cost for v2/v3 investigations (including web grounding). v1 is not metered per decision.",
];

/** "fable-5-1" → "Fable 5.1", "haiku-4-5-20251001" → "Haiku 4.5", "sonnet-4-6" → "Sonnet 4.6". */
export function modelLabel(shortId: string): string {
  const parts = shortId.split("-").filter((p) => !/^\d{8}$/.test(p));
  const name = parts[0] ?? shortId;
  const version = parts.slice(1).filter((p) => /^\d+$/.test(p)).join(".");
  const pretty = name.charAt(0).toUpperCase() + name.slice(1);
  return version ? `${pretty} ${version}` : pretty;
}

/** Peak-to-trough drawdown of an equity path, as a positive percentage of the peak. */
export function maxDrawdownPct(path: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const v of path) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, ((peak - v) / peak) * 100);
  }
  return worst;
}

function hit(scores: ScoreRow[], horizon: string): HitRate | null {
  const row = scores.find((s) => s.group === "trades" && s.horizon === horizon);
  return row && row.n > 0 ? { n: row.n, pct: row.positivePct } : null;
}

function daysBetween(fromIso: string | null, toIso: string): number {
  if (!fromIso) return 0;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 86_400_000) : 0;
}

/** Equity at the first snapshot on or after `day`; the seed when the arm began that day or later. */
function equityAt(arm: Arm, dayIso: string): number | null {
  const day = dayIso.slice(0, 10);
  if (arm.inceptionIso && arm.inceptionIso.slice(0, 10) >= day) return arm.seed;
  const snap = [...arm.snapshots].sort((a, b) => a.day.localeCompare(b.day)).find((s) => s.day >= day);
  return snap ? snap.equity : null;
}

export function buildLeaderboard(input: LeaderboardInput): Leaderboard {
  const inceptions = input.arms.map((a) => a.arm.inceptionIso).filter((x): x is string => !!x);
  const commonStartIso = inceptions.length ? inceptions.reduce((a, b) => (a > b ? a : b)) : null;

  const rows: LeaderboardRow[] = input.arms.map((a) => {
    const arm = a.arm;
    const path = [arm.seed, ...[...arm.snapshots].sort((x, y) => x.day.localeCompare(y.day)).map((s) => s.equity), arm.equity];
    const base = commonStartIso ? equityAt(arm, commonStartIso) : null;
    const pnl = arm.equity - arm.seed;
    return {
      rank: 0,
      key: arm.key,
      label: arm.label,
      model: a.model,
      design: a.design,
      inceptionIso: arm.inceptionIso,
      days: daysBetween(arm.inceptionIso, input.generatedAtIso),
      seed: arm.seed,
      equity: arm.equity,
      returnPct: arm.returnPct,
      spyReturnPct: a.spyReturnPct,
      excessPct: a.spyReturnPct === null ? null : arm.returnPct - a.spyReturnPct,
      sinceCommonPct: base && base > 0 ? ((arm.equity - base) / base) * 100 : null,
      maxDrawdownPct: maxDrawdownPct(path),
      fills: arm.fills,
      positions: arm.positions.length,
      realized: arm.realized,
      unrealized: arm.unrealized,
      hit1d: hit(a.scores, "1d"),
      hit7d: hit(a.scores, "7d"),
      spendUsd: a.spendUsd,
      pnlPerSpendDollar: a.spendUsd && a.spendUsd > 0 ? pnl / a.spendUsd : null,
    };
  });
  rows.sort((x, y) => y.returnPct - x.returnPct || (y.excessPct ?? -Infinity) - (x.excessPct ?? -Infinity));
  rows.forEach((r, i) => (r.rank = i + 1));
  return { generatedAtIso: input.generatedAtIso, commonStartIso, rows, benchmarks: input.benchmarks, caveats: CAVEATS };
}

// ---------------------------------------------------------------------------
// Rendering

const pct = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
const usd0 = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const usd2 = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);
const hitCell = (h: HitRate | null): string => (h ? `${h.pct.toFixed(0)}% (n=${h.n})` : "—");
const drawdown = (n: number): string => (n > 0.005 ? `−${n.toFixed(2)}%` : "0.00%");
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "—");

/** The full table: one row per arm, every column. */
export function renderMarkdownTable(lb: Leaderboard): string {
  const head = [
    "| # | Arm | Model | Since | Days | Equity | Return on seed | SPY same window | Excess vs SPY | Since common start | Max drawdown | Fills | Hit 1d | Hit 7d | LLM spend | P&L per $1 LLM |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  const body = lb.rows.map(
    (r) =>
      `| ${r.rank} | **${r.label}** | ${r.model} | ${day(r.inceptionIso)} | ${r.days} | ${usd0(r.equity)} | **${pct(r.returnPct)}** | ${pct(r.spyReturnPct)} | ${r.excessPct === null ? "—" : `${r.excessPct > 0 ? "+" : ""}${r.excessPct.toFixed(2)} pp`} | ${pct(r.sinceCommonPct)} | ${drawdown(r.maxDrawdownPct)} | ${r.fills} | ${hitCell(r.hit1d)} | ${hitCell(r.hit7d)} | ${usd2(r.spendUsd)} | ${r.pnlPerSpendDollar === null ? "—" : `$${r.pnlPerSpendDollar.toFixed(2)}`} |`,
  );
  return [...head, ...body].join("\n");
}

/** The compact table for the repository README. */
export function renderCompactTable(lb: Leaderboard): string {
  const head = ["| # | Arm | Model | Return on seed | Excess vs SPY | Max drawdown | Hit 1d | LLM spend |", "|---|---|---|---:|---:|---:|---:|---:|"];
  const body = lb.rows.map(
    (r) =>
      `| ${r.rank} | **${r.label}** | ${r.model} | **${pct(r.returnPct)}** | ${r.excessPct === null ? "—" : `${r.excessPct > 0 ? "+" : ""}${r.excessPct.toFixed(2)} pp`} | ${drawdown(r.maxDrawdownPct)} | ${hitCell(r.hit1d)} | ${usd2(r.spendUsd)} |`,
  );
  return [...head, ...body].join("\n");
}

export function renderDesigns(lb: Leaderboard): string {
  return lb.rows.map((r) => `- **${r.label}** — ${r.design}`).join("\n");
}

const stamp = (iso: string): string => iso.replace("T", " ").slice(0, 16) + " UTC";

/** `leaderboard/README.md`: the full picture. */
export function renderLeaderboardReadme(lb: Leaderboard, opts: { svgFile: string }): string {
  const bench = lb.benchmarks.map((b) => `${b.symbol} ${pct(b.returnPct)}`).join(" · ");
  return [
    "# fin leaderboard",
    "",
    `Three decision designs, one news feed, paper money. Ranked by return on seed. Updated ${stamp(lb.generatedAtIso)}; regenerated by \`npm run leaderboard\` in \`v2/\`.`,
    "",
    `![Equity since inception](${opts.svgFile})`,
    "",
    renderMarkdownTable(lb),
    "",
    `Benchmarks since the v2 inception: ${bench || "unavailable"}.${lb.commonStartIso ? ` Common start: ${day(lb.commonStartIso)}.` : ""}`,
    "",
    "## The arms",
    "",
    renderDesigns(lb),
    "",
    "## Read this before drawing conclusions",
    "",
    ...lb.caveats.map((c) => `- ${c}`),
    "",
    "Machine-readable: `leaderboard.json`. Badges: `badge-<arm>.json` and `badge-leader.json` (shields.io endpoint format).",
    "",
  ].join("\n");
}

export const README_START = "<!-- leaderboard:start -->";
export const README_END = "<!-- leaderboard:end -->";

/** The block that goes between the markers in the repository README. */
export function renderReadmeSection(lb: Leaderboard, opts: { svgPath: string; detailPath: string }): string {
  const leader = lb.rows[0];
  return [
    README_START,
    `*Updated ${stamp(lb.generatedAtIso)}${leader ? ` · leading: **${leader.label}** at ${pct(leader.returnPct)} on seed` : ""}. Paper money; see the caveats in [${opts.detailPath}](${opts.detailPath}).*`,
    "",
    `![Equity since inception](${opts.svgPath})`,
    "",
    renderCompactTable(lb),
    README_END,
  ].join("\n");
}

/**
 * Replace the marked block in a README, or add a "## Leaderboard" section
 * (before "## Pipeline" when present, else at the end) the first time.
 */
export function injectSection(readme: string, block: string): string {
  const s = readme.indexOf(README_START);
  const e = readme.indexOf(README_END);
  if (s >= 0 && e > s) return readme.slice(0, s) + block + readme.slice(e + README_END.length);
  const section = `## Leaderboard\n\n${block}\n\n`;
  const pipeline = readme.indexOf("\n## Pipeline");
  if (pipeline >= 0) return readme.slice(0, pipeline + 1) + section + readme.slice(pipeline + 1);
  return readme.replace(/\s*$/, "\n\n") + section;
}

// ---------------------------------------------------------------------------
// Badges (shields.io endpoint JSON)

export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

export function armBadge(r: LeaderboardRow): Badge {
  return {
    schemaVersion: 1,
    label: `fin ${r.key} · ${r.model.split(" · ")[0]}`,
    message: `${pct(r.returnPct)} on seed · ${usd0(r.equity)}`,
    color: r.returnPct > 0 ? "brightgreen" : r.returnPct < 0 ? "red" : "lightgrey",
  };
}

export function leaderBadge(lb: Leaderboard): Badge {
  const r = lb.rows[0];
  return {
    schemaVersion: 1,
    label: "fin leaderboard",
    message: r ? `${r.label} leads · ${pct(r.returnPct)}` : "no data",
    color: r && r.returnPct > 0 ? "brightgreen" : "red",
  };
}

// ---------------------------------------------------------------------------
// Equity chart (static SVG, no dependencies; renders in a GitHub README)

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ROLE_COLOR: Record<CurveSeries["role"], string> = { focus: "#2a78d6", arm: "#1baf7a", identity: "#eb6834", context: "#898781" };

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

const fmtK = (v: number): string => (Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${v.toFixed(0)}`);
const fmtDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function renderEquitySvg(
  curve: CurveSeries[],
  opts: { seed?: number | null; title?: string; width?: number; height?: number; generatedAtIso?: string } = {},
): string {
  const W = opts.width ?? 960;
  const H = opts.height ?? 380;
  const m = { l: 64, r: 210, t: 46, b: 34 };
  const drawn = curve.filter((s) => s.points.length >= 2);
  const all = drawn.flatMap((s) => s.points);
  const title = esc(opts.title ?? "fin — equity since inception, paper, marked at liquidation");
  const sub = opts.generatedAtIso ? esc(`generated ${stamp(opts.generatedAtIso)}`) : "";
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12">
<rect width="${W}" height="${H}" rx="12" fill="#fcfcfb"/>
<text x="${m.l}" y="22" font-size="15" font-weight="600" fill="#0b0b0b">${title}</text>
<text x="${W - m.r}" y="22" text-anchor="end" fill="#898781" font-size="11">${sub}</text>`;
  if (all.length < 2) return `${head}\n<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#898781">not enough points yet</text>\n</svg>\n`;
  const xs = all.map((p) => p.tMs);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs) === x0 ? x0 + 1 : Math.max(...xs);
  const ys = all.map((p) => p.value).concat(typeof opts.seed === "number" ? [opts.seed] : []);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  const pad = (y1 - y0 || Math.abs(y0) || 1) * 0.06;
  y0 -= pad;
  y1 += pad;
  const X = (t: number) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const parts: string[] = [head];
  for (const v of niceTicks(y0, y1)) {
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#e1e0d9"/>`);
    parts.push(`<text x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" fill="#898781" font-size="11">${fmtK(v)}</text>`);
  }
  if (typeof opts.seed === "number") {
    parts.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${Y(opts.seed).toFixed(1)}" y2="${Y(opts.seed).toFixed(1)}" stroke="#898781" stroke-dasharray="4 4"/>`);
  }
  const order = { focus: 0, arm: 1, identity: 2, context: 3 };
  const sorted = [...drawn].sort((a, b) => order[a.role] - order[b.role]);
  const ends: { y: number; label: string; color: string }[] = [];
  for (const s of sorted) {
    const pts = [...s.points].sort((a, b) => a.tMs - b.tMs);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.tMs).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
    const color = ROLE_COLOR[s.role];
    const width = s.role === "focus" ? 2.4 : s.role === "context" ? 1.3 : 1.9;
    const dash = s.role === "context" ? ' stroke-dasharray="3 3"' : "";
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash} stroke-linejoin="round" stroke-linecap="round" data-series="${esc(s.key)}"/>`);
    const last = pts[pts.length - 1];
    ends.push({ y: Y(last.value), label: `${s.label} ${fmtK(last.value)}`, color });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) parts.push(`<text x="${W - m.r + 8}" y="${(e.y + 4).toFixed(1)}" fill="${e.color}" font-size="11">${esc(e.label)}</text>`);
  parts.push(`<text x="${m.l}" y="${H - 10}" fill="#898781" font-size="11">${fmtDay(x0)}</text>`);
  parts.push(`<text x="${W - m.r}" y="${H - 10}" text-anchor="end" fill="#898781" font-size="11">${fmtDay(x1)}</text>`);
  parts.push("</svg>");
  return parts.join("\n") + "\n";
}
