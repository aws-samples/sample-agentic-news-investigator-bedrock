// SPDX-License-Identifier: MIT-0
/**
 * Leaderboard generator: marks every paper book in the registry the way the dashboard
 * does, ranks the arms, and writes `<repo>/leaderboard/` (json, markdown,
 * equity SVG, shields.io badges) plus the marked block in the repository
 * README. Reads only; nothing here touches a queue or a table.
 *
 *   npm run leaderboard                 # write files
 *   npm run leaderboard -- --commit     # then git commit (and push when a remote exists)
 *   npm run leaderboard -- --out DIR --no-readme --dry-run
 *
 * Pure shaping and rendering live in leaderboard-data.ts (unit-tested); the
 * marks come from books.ts, shared with the dashboard, so the two never
 * disagree. Entry point: importing this module does nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.js";
import { FOCUS, ARM_DEFS, ARM_KEYS, tableOf, markArm, buildCurve, type Arm } from "./books.js";
import type { Arm as ArmDef } from "./arms.js";
import { totalSpend } from "./daily-report.js";
import { listScoreItems } from "./score.js";
import { scoreRows, shortModel, type ScoreRow } from "./dashboard-data.js";
import { BENCHMARKS, benchmarkReturns } from "./performance.js";
import {
  buildLeaderboard,
  renderLeaderboardReadme,
  renderReadmeSection,
  renderEquitySvg,
  injectSection,
  armBadge,
  leaderBadge,
  modelLabel,
  type ArmInput,
} from "./leaderboard-data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/**
 * The arms as model configurations, from the registry (`arms.json`). Agent
 * arms are scored and metered by the v2 code; a pipeline arm (v1) writes no
 * SCOREQ rows and meters its spend elsewhere, so both columns stay empty.
 */
interface ArmSpec { def: ArmDef; key: string; table: string; model: string; design: string; scored: boolean; metered: boolean }

function specOf(def: ArmDef): ArmSpec {
  const agent = def.kind === "agent";
  const model = modelLabel(shortModel(def.key === FOCUS ? config.masterModel : def.model));
  return {
    def,
    key: def.key,
    table: tableOf(def),
    model: agent
      ? `${model} · Agent SDK · ${def.worldModel ? "gated world model" : "Haiku 4.5 triage"}`
      : `${model} analysis · Haiku 4.5 triage · deterministic risk gate`,
    design: agent
      ? def.worldModel
        ? "Agentic investigator plus a typed, gated shared world model (entities, facts with expiry, exposure links) and an hourly curiosity loop."
        : "Agentic investigation (web grounding, primary sources, quotes) with unconstrained multi-action decisions and no risk gate; a deployment mandate and a paper broker's bookkeeping are the only limits."
      : "Serverless pipeline: Haiku triage → LLM analysis with a small tool loop → pure-Rust risk gate (confidence floor, caps, cooldown) → simulated execution. The LLM never touches prices or the ledger.",
    scored: agent,
    metered: agent,
  };
}

const ARMS: ArmSpec[] = ARM_KEYS.map((k) => specOf(ARM_DEFS.find((d) => d.key === k)!));

interface Args {
  out: string;
  readme: boolean;
  commit: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { out: path.join(REPO_ROOT, "leaderboard"), readme: true, commit: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--out") a.out = path.resolve(argv[++i]);
    else if (x === "--no-readme") a.readme = false;
    else if (x === "--commit") a.commit = true;
    else if (x === "--dry-run") a.dryRun = true;
    else throw new Error(`unknown argument ${x}`);
  }
  return a;
}

async function armInput(spec: ArmSpec, arm: Arm, nowMs: number): Promise<ArmInput> {
  const [scores, spend, spy] = await Promise.all([
    spec.scored
      ? listScoreItems("D#", spec.table).then((items) => scoreRows(items)).catch((e) => { console.warn(`[leaderboard] ${spec.key} scores unavailable:`, e); return [] as ScoreRow[]; })
      : Promise.resolve([] as ScoreRow[]),
    spec.metered ? totalSpend(spec.table).catch(() => null) : Promise.resolve(null),
    arm.inceptionIso
      ? benchmarkReturns(Date.parse(arm.inceptionIso), BENCHMARKS.filter((b) => b.symbol === "SPY")).then((r) => r[0]?.returnPct ?? null).catch(() => null)
      : Promise.resolve(null),
  ]);
  void nowMs;
  return { arm, model: spec.model, design: spec.design, spendUsd: spend, scores, spyReturnPct: spy };
}

export async function generate(args: Args): Promise<void> {
  const nowMs = Date.now();
  const generatedAtIso = new Date(nowMs).toISOString();
  const marked = await Promise.all(ARMS.map((s) => markArm(s.def).catch((e) => { console.warn(`[leaderboard] ${s.key} unavailable:`, e); return null; })));
  const present = ARMS.map((s, i) => ({ spec: s, arm: marked[i] })).filter((x): x is { spec: ArmSpec; arm: Arm } => !!x.arm);
  if (present.length === 0) throw new Error("no arm could be marked (credentials? tables?)");
  const ordered = present.map((p) => p.arm);
  const focus = ordered.find((a) => a.key === FOCUS) ?? null;
  const [{ curve, benchmarks }, inputs] = await Promise.all([
    buildCurve(ordered, focus, nowMs),
    Promise.all(present.map((p) => armInput(p.spec, p.arm, nowMs))),
  ]);
  const lb = buildLeaderboard({ generatedAtIso, arms: inputs, curve, benchmarks });
  const svg = renderEquitySvg(curve, { seed: focus?.seed ?? null, generatedAtIso });

  if (args.dryRun) {
    console.log(renderLeaderboardReadme(lb, { svgFile: "equity.svg" }));
    return;
  }
  fs.mkdirSync(args.out, { recursive: true });
  const write = (name: string, body: string) => fs.writeFileSync(path.join(args.out, name), body);
  write("leaderboard.json", JSON.stringify(lb, null, 2) + "\n");
  write("README.md", renderLeaderboardReadme(lb, { svgFile: "equity.svg" }));
  write("equity.svg", svg);
  for (const r of lb.rows) write(`badge-${r.key}.json`, JSON.stringify(armBadge(r), null, 2) + "\n");
  write("badge-leader.json", JSON.stringify(leaderBadge(lb), null, 2) + "\n");
  const touched = [args.out];
  if (args.readme) {
    const readmePath = path.join(REPO_ROOT, "README.md");
    const rel = path.relative(REPO_ROOT, args.out).split(path.sep).join("/");
    const current = fs.readFileSync(readmePath, "utf8");
    const next = injectSection(current, renderReadmeSection(lb, { svgPath: `${rel}/equity.svg`, detailPath: `${rel}/README.md` }));
    if (next !== current) fs.writeFileSync(readmePath, next);
    touched.push(readmePath);
  }
  const leader = lb.rows[0];
  console.log(`[leaderboard] ${lb.rows.length} arms · leading ${leader?.label} ${leader ? leader.returnPct.toFixed(2) : "?"}% · wrote ${args.out}`);

  if (args.commit) {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" });
    git("add", "--", ...touched);
    const staged = git("diff", "--cached", "--name-only").trim();
    if (!staged) {
      console.log("[leaderboard] nothing changed; no commit");
      return;
    }
    git("commit", "-q", "-m", `leaderboard ${generatedAtIso.slice(0, 10)}: ${leader?.label} ${leader ? (leader.returnPct >= 0 ? "+" : "") + leader.returnPct.toFixed(2) : "?"}% on seed`);
    const remotes = git("remote").trim();
    if (remotes) {
      git("push", "-q");
      console.log(`[leaderboard] committed and pushed to ${remotes.split("\n")[0]}`);
    } else {
      console.log("[leaderboard] committed (no git remote configured, not pushed)");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generate(parseArgs(process.argv.slice(2))).catch((e) => {
    console.error("[leaderboard] failed:", e);
    process.exit(1);
  });
}
