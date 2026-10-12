#!/usr/bin/env bash
# SPDX-License-Identifier: MIT-0
# Regenerates v2/.env.example from the environment variables the v2 runtime reads.
#
# Source of truth is v2/src/config.ts (every knob is documented there with the
# incident that set it); the other modules under v2/src that read process.env
# directly (dashboard, report, letter, print) are appended in a second section.
# For each variable the generator emits a one-line purpose lifted from the
# nearest preceding comment and the default the code applies when the variable
# is unset. Run it after adding a knob; the output is checked in.
#
#   scripts/oss/gen-env-example.sh            # writes v2/.env.example
#   scripts/oss/gen-env-example.sh --check    # exit 1 if the checked-in file is stale
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODE="${1:-write}"

FIN_ROOT="$ROOT" FIN_MODE="$MODE" node - <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.FIN_ROOT;
const mode = process.env.FIN_MODE;
const srcDir = path.join(root, "v2", "src");
const outFile = path.join(root, "v2", ".env.example");

// Variables the runtime does not own (inherited from the OS or the shell).
const IGNORE = new Set(["HOME", "PATH", "DYLD_FALLBACK_LIBRARY_PATH", "HOMEBREW_PREFIX"]);

// Purposes for knobs whose config.ts line carries no comment of its own, plus
// notes the comments do not state (required-ness).
const PURPOSE = {
  AWS_REGION: "AWS region for every SDK client (DynamoDB, SQS, S3, SSM, Bedrock).",
  V2_TABLE: "DynamoDB table for this arm's paper book, audit rows, theses and scores.",
  V2_TAPE_TABLE: "DynamoDB quote tape shared by every arm: each observed price, stamped when observed, so the bench can price as-of an event.",
  V2_DRY_RUN: "Decide and audit but never fill (the default); set to false to let paper fills into the book happen.",
  V2_WATCH_MIN_DEPTH_USD: "Position watcher: a move only counts as an alert when the venue shows at least this much resting depth (USD).",
  V2_WATCH_MAX_SPREAD_FRAC: "Position watcher: a move only counts as an alert when the spread is no wider than this fraction of the mid.",
  V2_FX_MAX_SPREAD_BPS: "FX majors: above this spread (bps) the venue's fiat book is ignored in favour of the interbank reference rate.",
  V2_PENDING_SLICE_MIN: "Working reduce-only orders: minutes between successive 25%-of-book slices of a liquidity-capped exit.",
  V2_ARM: "Which arm this process is (v2 = unassisted control, v3 = world model); prefixes logs and transcripts.",
  V2_WORLD_MODEL: "Set to 1 for the v3 arm: typed, gated world model shared across investigations plus the hourly curiosity loop.",
  V2_LETTER_EFFORT: "Reasoning effort for the daily letter's narrative (low | medium | high | xhigh | max); unset = the API default (high).",
  V2_QUEUE_URL: "SQS queue the worker long-polls for NewsItem events (FinStack output). Required by the worker.",
  V2_TRANSCRIPT_BUCKET: "S3 bucket for full agent transcripts (FinStack output). Required by the worker.",
  V2_KILL_SWITCH_PARAM: "SSM parameter the worker polls; any value other than 'off' halts this arm.",
  V2_DAILY_BUDGET_PARAM: "SSM parameter holding this arm's daily LLM spend cap in USD.",
  V2_TRIAGE_MODEL: "Bedrock model id for Haiku triage (and filing summaries).",
  V2_MASTER_MODEL: "Bedrock model id the Agent SDK investigator runs on.",
  V2_TRIAGE_THRESHOLD: "Triage materiality at or above which a story is investigated.",
  V2_WATCH_MOVE_PREDICTION_PCT: "Position watcher: leg size (percent) that triggers a re-evaluation for prediction contracts.",
  V2_WATCH_COOLDOWN_HOURS: "Position watcher: hours before the same position may raise another alert.",
  V2_MAX_NEWS_AGE_HOURS: "Drop queued news older than this many hours instead of investigating it.",
  V2_MAX_TURNS: "Agent SDK turn budget per investigation.",
  V2_MAX_BUDGET_PER_RUN_USD: "Agent SDK spend ceiling per investigation, USD.",
  V2_MAX_INVESTIGATIONS_PER_DAY: "Per-day cap on investigations, independent of the dollar budget.",
  V2_CURIOSITY_INTERVAL_MIN: "v3 only: minutes between curiosity passes over the world model.",
  V2_CURIOSITY_COOLDOWN_HOURS: "v3 only: hours before the same curiosity trigger may fire again.",
  V2_INCEPTION: "ISO timestamp the book went live; anchors return-since-inception and the benchmark window.",
  V2_EDGAR_CONTACT: "REQUIRED for read_source: contact email in the SEC EDGAR User-Agent (fair-access policy). No fallback.",
  EDGAR_CONTACT: "Alternative name for V2_EDGAR_CONTACT (the CDK stack passes this one to v1's poller).",
  V2_MANDATE_MIN_DEPLOYED: "Deployment mandate: lower edge of the deployed-equity band (fraction).",
  V2_MANDATE_MAX_DEPLOYED: "Deployment mandate: upper edge of the deployed-equity band (fraction).",
  V2_MANDATE_MAX_POSITION: "Deployment mandate: cap on any single position as a fraction of equity.",
  V2_MANDATE_WATCHLIST_HOURS: "Deployment mandate: how far back the watchlist of previously-named instruments reaches.",
  V1_TABLE: "DynamoDB table of the v1 (Rust pipeline) arm, read by the A/B report and the letter.",
  V3_TABLE: "DynamoDB table of the v3 (world-model) arm, read by the A/B report and the dashboard.",
  V2_DASHBOARD_PORT: "Loopback port the read-only dashboard listens on.",
  V2_DASHBOARD_REFRESH_SECS: "Seconds between dashboard snapshot refreshes while a page is open.",
  V2_WORKER_LOG: "Path of the v2 worker log the dashboard tails for health; unset = the supervisor's default location.",
  V3_WORKER_LOG: "Path of the v3 worker log the dashboard tails for health; unset = the supervisor's default location.",
  V2_PRINT: "Set to 1 to send the daily letter's narrative PDF to a printer after generating it.",
  V2_PRINTER: "CUPS printer name for V2_PRINT; unset = the system default printer.",
  V2_WEASYPRINT: "Path to the weasyprint binary when it is not on PATH or in a common prefix.",
  V2_WEASYPRINT_LIB_DIR: "Directory holding weasyprint's native libraries (glib/pango/cairo) when the dynamic loader cannot find them.",
  V2_YIELD_TRIAGE: "Set to 'on' for yield-aware triage: per-category bars from STATE/YIELD (npm run yield -- --write). Off by default; bench first.",
  V2_YIELD_HALF_LIFE_DAYS: "Yield triage: half-life (days) of the decay weight on each category's cost and P&L.",
  V2_YIELD_MIN_N: "Yield triage: pseudo-observations shrinking a category's yield toward the global yield.",
  V2_YIELD_MATURITY_DAYS: "Yield triage: a decision counts toward P&L only once this old (so its 7-day score exists).",
  V2_YIELD_MAX_SHIFT: "Yield triage: most a category's bar may move from V2_TRIAGE_THRESHOLD, either way.",
  V2_YIELD_FLOOR: "Yield triage: lowest bar any category can reach.",
  V2_YIELD_CEIL: "Yield triage: highest bar any category can reach.",
  V2_YIELD_EXPLORATION_PER_DAY: "Yield triage: sub-bar items admitted per category per day so no category starves.",
  V2_YIELD_REFRESH_MIN: "Yield triage: minutes between the worker's re-reads of STATE/YIELD.",
  V2_EFFORT: "Investigator reasoning effort (low | medium | high | xhigh | max); unset = the arm's effort in arms.json, else the SDK default (high).",
  V2_DASHBOARD_URL: "Dashboard to export from (npm run dashboard:export); unset = http://127.0.0.1:<V2_DASHBOARD_PORT>.",
  V2_SUPERVISOR: "Service manager the dashboard reports worker health from (launchd | systemd | none); unset = launchd on macOS, none elsewhere.",
  V2_WORKER_LOG_PATTERN: "Worker log path template for arms other than the focus arm (<prefix>, <key>); unset = the supervisor's default.",
  V2_PRINT_CMD: "Command V2_PRINT runs with the PDF path as its only argument, on any platform; unset = /usr/bin/lp on macOS, nothing elsewhere.",
  V2_EVENT_BUS: "Bench (archive mode): EventBridge bus the replay reads; unset = <prefix>-events.",
  V2_REPLAY_RULE: "Bench (archive mode): the disabled rule a replay targets; unset = <prefix>-replay-rule.",
  V2_REPLAY_QUEUE: "Bench (archive mode): SQS queue the replay drains; unset = <prefix>-replay.",
  V2_EVENT_ARCHIVE: "Bench (archive mode): EventBridge archive replayed from; unset = <prefix>-events-archive.",
  REPORT_DAY: "YYYY-MM-DD: regenerate that day's letter instead of today's (never advances the letter anchor).",
  V2_BENCH_GUARDRAIL_ID: "Bench only: guardrail id for the `guardrail` variant (replay.ts sets it from --guardrail-id); nothing else reads it.",
  V2_BENCH_GUARDRAIL_VERSION: "Bench only: guardrail version for the `guardrail` variant (replay.ts sets it from --guardrail-version).",
};

const KEEP = /^(V1_|V2_|V3_|EDGAR_|AWS_REGION$|REPORT_DAY$)/;
// `env.X` covers arms.ts, which resolves arm defaults from an injected env.
// A chained fallback (`A ?? process.env.B ?? ""`) yields two variables, each
// matched on its own; only a literal directly after the operator is a default.
const ENV_RE = /\b(?:process\.)?env\.([A-Z0-9_]+)(?:\s*(?:\?\?|\|\|)\s*("([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?)|undefined))?/g;

function oneLine(text) {
  const s = text.replace(/\s+/g, " ").trim();
  const firstSentence = s.match(/^(.+?[.!?])(\s|$)/);
  const line = firstSentence ? firstSentence[1] : s;
  return line.length > 140 ? line.slice(0, 137).replace(/\s+\S*$/, "") + "..." : line;
}

function stripComment(line) {
  return line
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*\*\s?/, "")
    .replace(/^\s*\/\/\s?/, "")
    .trim();
}

/** Walk a file, yielding {name, def, purpose, line} for every env read. */
function scan(file) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const found = [];
  let comment = [];
  let inBlock = false;
  lines.forEach((raw, i) => {
    const t = raw.trim();
    const isCommentStart = t.startsWith("/*");
    const isCommentLine = inBlock || isCommentStart || t.startsWith("//") || t.startsWith("*");
    if (isCommentStart) { inBlock = !t.includes("*/"); comment = [stripComment(t)]; return; }
    if (inBlock) { comment.push(stripComment(t)); if (t.includes("*/")) inBlock = false; return; }
    if (t.startsWith("//")) { comment.push(stripComment(t)); return; }
    if (t.startsWith("*")) { comment.push(stripComment(t)); return; }
    if (t === "") { comment = []; return; }
    let m;
    let hit = false;
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(raw)) !== null) {
      const name = m[1];
      if (IGNORE.has(name) || !KEEP.test(name)) continue;
      hit = true;
      let def = "";
      if (m[3] !== undefined) def = m[3];
      else if (m[4] !== undefined) def = m[4];
      else if (m[5] !== undefined) def = m[5];
      const commentText = comment.filter(Boolean).join(" ");
      found.push({ name, def, line: i + 1, file: rel, purpose: PURPOSE[name] ?? (commentText ? oneLine(commentText) : "") });
    }
    // A comment applies to the property it precedes; keep it across an opening
    // brace so `mandate: {` and its members share one, drop it otherwise.
    if (!hit && !t.endsWith("{")) comment = [];
    else if (hit && !isCommentLine) comment = comment.length && t.endsWith("{") ? comment : [];
  });
  return found;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith(".ts")) yield p;
  }
}

const configFile = path.join(srcDir, "config.ts");
const fromConfig = scan(configFile);
const seen = new Set(fromConfig.map((v) => v.name));
const others = [];
for (const f of [...walk(srcDir)].sort()) {
  if (f === configFile) continue;
  for (const v of scan(f)) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    others.push(v);
  }
}

const out = [];
out.push("# fin v2/v3 worker environment — generated by scripts/oss/gen-env-example.sh from v2/src; do not edit by hand.");
out.push("# Export these in the worker's environment (shell, or the service manager's unit file); nothing loads a");
out.push("# .env file automatically. A blank value means there is no default; otherwise the value shown is what the");
out.push("# code applies when the variable is unset.");
out.push("# Defaults and the incidents that set them are documented next to each knob in v2/src/config.ts.");
out.push("");
out.push("# ---- v2/src/config.ts");
for (const v of fromConfig) {
  out.push(`# ${v.purpose || `See config.ts:${v.line}.`}`);
  out.push(`${v.name}=${v.def}`);
}
out.push("");
out.push("# ---- read directly by other modules (reporting and operations, never the decision path)");
for (const v of others) {
  out.push(`# ${v.purpose || `See ${v.file}:${v.line}.`} [${v.file}]`);
  out.push(`${v.name}=${v.def}`);
}
const text = out.join("\n") + "\n";
const count = fromConfig.length + others.length;

if (mode === "--check") {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;
  if (current !== text) {
    console.error("v2/.env.example is stale; run scripts/oss/gen-env-example.sh");
    process.exit(1);
  }
  console.log(`v2/.env.example is current (${count} variables)`);
} else {
  fs.writeFileSync(outFile, text);
  console.log(`wrote ${path.relative(root, outFile)} (${count} variables)`);
}
EOF
