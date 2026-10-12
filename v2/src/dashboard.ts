// SPDX-License-Identifier: MIT-0
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config, arms } from "./config.js";
import { resourcesOf, type Arm as ArmDef } from "./arms.js";
import { FOCUS, ARM_DEFS, ARM_KEYS, tableOf, markArm, buildCurve, type Arm } from "./books.js";
import { checkBudget, killSwitchOn, dailyBudgetUsd } from "./budget.js";
import { listScoreItems } from "./score.js";
import { listPending, type PendingOrder } from "./pending.js";
import { getTheses } from "./thesis.js";
import { BENCHMARKS } from "./performance.js";
import { coverageGaps } from "./letter.js";
import { worldStats, type WorldStats } from "./world.js";
import { buildStaticDashboard, snapshotFileName } from "./dashboard-static.js";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { ddb } from "./ledger.js";
import { bookUtilization } from "./mandate.js";
import { dayKey } from "./budget.js";
import {
  gatherEvents,
  gatherFills,
  readSnapshots,
  readInception,
  totalSpend,
  isErrored,
} from "./daily-report.js";
import {
  compactEvent,
  hourlyPulse,
  scoreRows,
  indexedSeries,
  dayNoonMs,
  compactCorrections,
  describeOrders,
  mandateStatus,
  benchRows,
  armRole,
  orderArmKeys,
  defaultSupervisor,
  supervisorUnit,
  workerLogPath,
  printerProbesEnabled,
  parseLaunchdPrint,
  parseSystemctlShow,
  type CompactEvent,
  type CurveSeries,
  type PulseBucket,
  type ScoreRow,
  type CompactCorrection,
  type OrderView,
  type MandateView,
  type BenchRow,
  type ArmRole,
  type Supervisor,
  type SupervisorState,
} from "./dashboard-data.js";

/**
 * Local dashboard: one page at http://127.0.0.1:4310 showing every arm's paper
 * book (arms.json; the focus arm is config.arm), the equity curve against the
 * benchmarks the letter uses, what the agent has been looking at, when it was
 * NOT looking, and the outcome scores. Reads the same rows as the daily letter;
 * nothing here writes. Loopback only.
 *
 * Platform probes degrade rather than fail: the process supervisor is
 * V2_SUPERVISOR=launchd|systemd|none (default launchd on darwin, none
 * elsewhere), CUPS is consulted only on darwin when printing is configured
 * (V2_PRINT or V2_PRINTER), and worker log paths come from V2_WORKER_LOG (the
 * focus arm) or V2_WORKER_LOG_PATTERN (<prefix>, <key> placeholders).
 *
 * Run: npm run dashboard (compiled) or npm run dashboard:dev.
 */

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(HERE, "..", "dashboard");
const REPORTS_DIR = path.resolve(HERE, "..", "reports");
const PORT = Number(process.env.V2_DASHBOARD_PORT ?? 4310);
const REFRESH_MS = Number(process.env.V2_DASHBOARD_REFRESH_SECS ?? 90) * 1000;
/** Only keep refreshing while someone has loaded the page recently. */
const IDLE_AFTER_MS = 5 * 60_000;
const WINDOW_MS = 7 * 86_400_000;
const GAP_MS = 2 * 3_600_000;
/** The quote tape started capturing on this day; nothing before it is on the tape. */
const TAPE_SINCE = "2026-09-04";
const SUPERVISOR: Supervisor = defaultSupervisor(process.platform, process.env.V2_SUPERVISOR);
const HOME = process.env.HOME ?? os.homedir();
// FOCUS, ARM_DEFS, ARM_KEYS, tableOf, markArm, buildCurve, DashPosition, Arm: books.ts (shared with the leaderboard).
const sqs = new SQSClient({ region: config.region });
const ssm = new SSMClient({ region: config.region });
const ddbRaw = new DynamoDBClient({ region: config.region });

/** The focus arm honours V2_WORKER_LOG; every arm falls back to the pattern rule. */
function logPathFor(key: string): string {
  if (key === FOCUS && process.env.V2_WORKER_LOG) return process.env.V2_WORKER_LOG;
  return workerLogPath({ pattern: process.env.V2_WORKER_LOG_PATTERN, platform: process.platform, home: HOME, prefix: config.prefix, key });
}


interface LetterInfo {
  day: string;
  mtimeIso: string;
  opening: string;
  watching: string;
  files: { md: string; pdf: string | null; docx: string | null };
}

interface SupervisorInfo extends SupervisorState {
  kind: Supervisor;
  unit: string;
}

interface Overview {
  generatedAt: string;
  refreshSeconds: number;
  windowStartMs: number;
  /** Every arm in arms.json by key (null when its book is absent); `armKeys` gives the display order, focus first. */
  arms: Record<string, Arm | null>;
  armKeys: string[];
  focusArm: string;
  /** The arm whose world model `world` describes (the focus arm when it runs one, else the first that does). */
  worldArm: string | null;
  /** The world model: what it holds, what the gate ruled, what curiosity asked. Null when no arm runs one. */
  world: {
    stats: WorldStats;
    proposals: { accepted: number; rejected: number; checks: Record<string, number> };
    rejections: { at: string; headline: string; text: string }[];
    curiosity: { at: string; headline: string; outcome: string; filled: boolean; cost?: number }[];
    events: CompactEvent[];
  } | null;
  curve: CurveSeries[];
  benchmarks: { symbol: string; label: string; returnPct: number | null }[];
  spend: {
    todayUsd: number;
    todayInvestigations: number;
    dailyBudgetUsd: number;
    newsCeilingUsd: number;
    toDateUsd: number;
    /** From the worker's own refusal rows today, not re-derived here (the caps live in its env). */
    allowed: boolean;
    reason: string | null;
    trippedAtIso: string | null;
  };
  worker: {
    supervisor: { kind: Supervisor; state: string; pid: number | null } | null;
    logMtimeIso: string | null;
    logLastLine: string | null;
    lastRowIso: string | null;
    killSwitch: boolean;
  };
  scores: ScoreRow[];
  events: CompactEvent[];
  pulse: PulseBucket[];
  gaps: { fromMs: number; toMs: number }[];
  theses: { symbol: string; at: string; action: string; confidence: number; trigger: string; rationale: string }[];
  pending: PendingOrder[];
  letters: LetterInfo[];
  model: string;
  /** Where the focus book sits against the deployment mandate (mandate.ts), marked as the dashboard marks. */
  mandate: MandateView | null;
  /** PENDING# rows split into working exits (still slicing the book) and plain parked orders. */
  orders: { working: OrderView[]; parked: OrderView[] };
  /** At-cost reversals in the window — administrative, never trades. */
  corrections: CompactCorrection[];
  ops: {
    supervisor: Supervisor;
    arms: ArmOps[];
    letter: LetterOps;
    tape: { table: string; itemCount: number | null; sizeBytes: number | null; captureSince: string } | null;
  };
  /** Latest replay-bench summaries (BENCHSUM rows), newest first. */
  bench: BenchRow[];
}

interface ArmOps {
  key: string;
  label: string;
  supervisor: { kind: Supervisor; state: string; pid: number | null; lastExitCode: number | null } | null;
  logMtimeIso: string | null;
  logLastLine: string | null;
  queue: { name: string; visible: number; inFlight: number } | null;
  spendTodayUsd: number;
  investigationsToday: number;
  budgetUsd: number | null;
  killSwitch: boolean | null;
}

interface LetterOps {
  /** The newest REPORT / DAY#<day> anchor row: the window the next letter starts from. */
  lastRun: { day: string; generatedAt: string; windowStart: string } | null;
  supervisor: { kind: Supervisor; state: string; lastExitCode: number | null; runs: number | null } | null;
  scheduledLocal: string;
  printer: { name: string; state: string; alerts: string[] } | null;
  /** CUPS reports a failed job through `Status:` and/or `Alerts:` (e.g. processing-to-stop-point, job-canceled-by-user). */
  lastJob: { id: string; submittedAt: string | null; status: string | null; alerts: string | null; failed: boolean } | null;
}

async function buildWorld(table: string, sinceMs: number): Promise<Overview["world"]> {
  const [stats, gathered] = await Promise.all([worldStats(table), gatherEvents(sinceMs, table)]);
  const events = gathered.events.map((e) => compactEvent(e, isErrored(e)));
  const proposals = { accepted: 0, rejected: 0, checks: {} as Record<string, number> };
  const rejections: { at: string; headline: string; text: string }[] = [];
  for (const e of events) {
    if (!e.proposals) continue;
    proposals.accepted += e.proposals.accepted;
    proposals.rejected += e.proposals.rejected;
    for (const [k, v] of Object.entries(e.proposals.checks)) proposals.checks[k] = (proposals.checks[k] ?? 0) + v;
    for (const r of e.rejections) rejections.push({ at: e.at, headline: e.headline, text: r });
  }
  rejections.sort((a, b) => b.at.localeCompare(a.at));
  const curiosity = events
    .filter((e) => e.curiosity && e.investigated)
    .sort((a, b) => b.atMs - a.atMs)
    .map((e) => {
      const d = e.decisions.find((x) => x.action !== "hold") ?? e.decisions[0];
      const outcome = d ? `${d.action}${d.symbol ? ` ${d.symbol}` : ""}${d.watch && d.action === "hold" ? ` (watch ${d.watch})` : ""} · ${d.confidence.toFixed(2)}` : "no decision";
      return { at: e.at, headline: e.headline, outcome, filled: e.fills.length > 0, cost: e.cost };
    });
  return { stats, proposals, rejections: rejections.slice(0, 30), curiosity: curiosity.slice(0, 30), events };
}

/**
 * What the process supervisor knows about an arm's unit, or null when there is
 * no supervisor here, the probe is unavailable, or the unit is not loaded.
 * launchd: `launchctl print gui/<uid>/<label>`; systemd: `systemctl show`
 * (system scope, then the user's). Never throws.
 */
async function supervisorInfo(role: "worker" | "daily-report", key: string): Promise<SupervisorInfo | null> {
  const unit = supervisorUnit(SUPERVISOR, config.prefix, key, role);
  if (!unit) return null;
  try {
    if (SUPERVISOR === "launchd") {
      if (process.platform !== "darwin") return null;
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      const { stdout } = await execFileP("launchctl", ["print", `gui/${uid}/${unit}`]);
      return { kind: "launchd", unit, ...parseLaunchdPrint(stdout) };
    }
    if (SUPERVISOR === "systemd") {
      const props = "LoadState,ActiveState,SubState,MainPID,ExecMainStatus,NRestarts";
      for (const scope of [[], ["--user"]]) {
        const { stdout } = await execFileP("systemctl", [...scope, "show", unit, "-p", props]);
        const parsed = parseSystemctlShow(stdout);
        if (parsed.state !== "not loaded") return { kind: "systemd", unit, ...parsed };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** mtime and last line of a worker log, or nulls when it is not on this machine. */
function logInfo(file: string): { logMtimeIso: string | null; logLastLine: string | null } {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(4096, st.size);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter(Boolean);
      return { logMtimeIso: st.mtime.toISOString(), logLastLine: lines.at(-1)?.slice(0, 200) ?? null };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { logMtimeIso: null, logLastLine: null };
  }
}

async function ssmParam(name: string | null): Promise<string | null> {
  if (!name) return null;
  try {
    const r = await ssm.send(new GetParameterCommand({ Name: name }));
    return r.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/** Visible and in-flight messages on an arm's news queue (by name, so no per-arm env is needed). */
async function queueDepth(name: string | null): Promise<ArmOps["queue"]> {
  if (!name) return null;
  try {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) return null;
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }),
    );
    return {
      name,
      visible: Number(Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  } catch {
    return null;
  }
}

/** Today's SPEND / DAY#<utc-day> row of an arm's table (the breaker's own ledger). */
async function spendToday(table: string): Promise<{ costUsd: number; investigations: number }> {
  try {
    const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: "SPEND", sk: `DAY#${dayKey()}` } }));
    return { costUsd: Number(r.Item?.cost_usd ?? 0), investigations: Number(r.Item?.investigations ?? 0) };
  } catch {
    return { costUsd: 0, investigations: 0 };
  }
}

/** Operations view of one agent arm; the focus arm's params honour the env overrides, the others follow the registry. */
async function armOps(def: ArmDef): Promise<ArmOps> {
  const res = resourcesOf(def, arms);
  const focus = def.key === FOCUS;
  const [sup, queue, spend, budget, kill] = await Promise.all([
    supervisorInfo("worker", def.key),
    queueDepth(res.newsQueue),
    spendToday(tableOf(def)),
    ssmParam(focus ? config.dailyBudgetParam : res.budgetParam),
    ssmParam(focus ? config.killSwitchParam : res.killSwitchParam),
  ]);
  const { logMtimeIso, logLastLine } = logInfo(logPathFor(def.key));
  return {
    key: def.key,
    label: def.label,
    supervisor: sup ? { kind: sup.kind, state: sup.state, pid: sup.pid, lastExitCode: sup.lastExitCode } : null,
    logMtimeIso,
    logLastLine,
    queue,
    spendTodayUsd: spend.costUsd,
    investigationsToday: spend.investigations,
    budgetUsd: budget !== null && Number.isFinite(Number(budget)) ? Number(budget) : null,
    killSwitch: kill === null ? null : kill.trim() === "true",
  };
}

/** The CUPS printer's state and its last job: whether the letter actually came out. Darwin only, and only when printing is configured. */
async function printerOps(): Promise<{ printer: LetterOps["printer"]; lastJob: LetterOps["lastJob"] }> {
  if (!printerProbesEnabled(process.platform, process.env)) return { printer: null, lastJob: null };
  try {
    const { stdout: pd } = await execFileP("lpstat", ["-p", "-d"]);
    const name =
      process.env.V2_PRINTER ?? /system default destination: (\S+)/.exec(pd)?.[1] ?? /^printer (\S+)/m.exec(pd)?.[1];
    if (!name) return { printer: null, lastJob: null };
    const stateLine = pd.split("\n").find((l) => l.startsWith(`printer ${name} `)) ?? "";
    const state = /is (\w+)\./.exec(stateLine)?.[1] ?? /is (\w+)/.exec(stateLine)?.[1] ?? "unknown";
    let alerts: string[] = [];
    try {
      const { stdout: pl } = await execFileP("lpstat", ["-l", "-p", name]);
      const a = /Alerts: (.*)/.exec(pl)?.[1]?.trim();
      alerts = a ? a.split(/\s+/).filter((x) => x && x !== "none") : [];
    } catch {
      /* no detail */
    }
    let lastJob: LetterOps["lastJob"] = null;
    try {
      const { stdout: jl } = await execFileP("lpstat", ["-W", "all", "-l", "-o", name]);
      const blocks = jl.split(/\n(?=\S)/).filter((b) => b.startsWith(`${name}-`));
      const last = blocks.at(-1);
      if (last) {
        const head = last.split("\n")[0];
        const id = head.split(/\s+/)[0];
        const at = /(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})/.exec(head)?.[1] ?? null;
        const status = /Status: (.*)/.exec(last)?.[1]?.trim() || null;
        const jobAlerts = /Alerts: (.*)/.exec(last)?.[1]?.trim() || null;
        const failed = !!status || /processing-to-stop-point|job-canceled|aborted|job-hold-until-specified/.test(jobAlerts ?? "");
        lastJob = { id, submittedAt: at, status, alerts: jobAlerts, failed };
      }
    } catch {
      /* no jobs */
    }
    return { printer: { name, state, alerts }, lastJob };
  } catch {
    return { printer: null, lastJob: null };
  }
}

async function letterOps(): Promise<LetterOps> {
  const [runs, sup, printing] = await Promise.all([
    ddb
      .send(
        new QueryCommand({
          TableName: config.table,
          KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
          ExpressionAttributeValues: { ":p": "REPORT", ":s": "DAY#" },
          ScanIndexForward: false,
          Limit: 1,
        }),
      )
      .then((r) => (r.Items ?? []) as Array<{ day?: string; generated_at?: string; window_start?: string }>)
      .catch(() => []),
    supervisorInfo("daily-report", FOCUS),
    printerOps(),
  ]);
  const last = runs[0];
  return {
    lastRun: last ? { day: String(last.day), generatedAt: String(last.generated_at), windowStart: String(last.window_start) } : null,
    supervisor: sup ? { kind: sup.kind, state: sup.state, lastExitCode: sup.lastExitCode, runs: sup.runs } : null,
    scheduledLocal: "08:00",
    printer: printing.printer,
    lastJob: printing.lastJob,
  };
}

/** DescribeTable on the quote tape: approximate item count (DynamoDB refreshes it about every six hours). */
async function tapeStats(): Promise<Overview["ops"]["tape"]> {
  try {
    const r = await ddbRaw.send(new DescribeTableCommand({ TableName: config.tapeTable }));
    return {
      table: config.tapeTable,
      itemCount: r.Table?.ItemCount ?? null,
      sizeBytes: r.Table?.TableSizeBytes ?? null,
      captureSince: TAPE_SINCE,
    };
  } catch {
    return null;
  }
}

async function benchSummaries(): Promise<BenchRow[]> {
  try {
    const r = await ddb.send(
      new QueryCommand({ TableName: config.table, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "BENCHSUM" } }),
    );
    return benchRows((r.Items ?? []) as Array<Record<string, unknown>>).slice(0, 12);
  } catch {
    return [];
  }
}

async function workerStatus(lastRowIso: string | null): Promise<Overview["worker"]> {
  const [info, killSwitch] = await Promise.all([supervisorInfo("worker", FOCUS), killSwitchOn().catch(() => false)]);
  const { logMtimeIso, logLastLine } = logInfo(logPathFor(FOCUS));
  return {
    supervisor: info ? { kind: info.kind, state: info.state, pid: info.pid } : null,
    logMtimeIso,
    logLastLine,
    lastRowIso,
    killSwitch,
  };
}

function letterSummaries(): LetterInfo[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(REPORTS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 7);
  } catch {
    return [];
  }
  return files.map((f) => {
    const day = f.slice(0, 10);
    const full = path.join(REPORTS_DIR, f);
    const body = fs.readFileSync(full, "utf8");
    const narrative = body.split("## Data appendix")[0];
    const paras = narrative.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const opening =
      paras.find((p) => !p.startsWith("#") && !p.startsWith("_") && !p.startsWith("*")) ?? "";
    const wi = paras.findIndex((p) => /^(## |\*\*)What I am watching/i.test(p));
    const watching =
      wi >= 0 ? paras.slice(wi + 1).filter((p) => !/^(## |\*\*[^*]+\*\*$)/.test(p)).join("\n\n") : "";
    const has = (ext: string) => fs.existsSync(path.join(REPORTS_DIR, `${day}.${ext}`));
    return {
      day,
      mtimeIso: fs.statSync(full).mtime.toISOString(),
      opening: opening.slice(0, 420),
      watching: watching.slice(0, 1400),
      files: { md: f, pdf: has("pdf") ? `${day}.pdf` : null, docx: has("docx") ? `${day}.docx` : null },
    };
  });
}

async function buildOverview(): Promise<Overview> {
  const nowMs = Date.now();
  // Mark every arm first: the focus arm's inception (STATE/INCEPTION, else its
  // first fill) bounds the window, and marking is the slow part anyway.
  const marked = await Promise.all(
    ARM_DEFS.map((def) =>
      markArm(def).catch((e) => {
        console.warn(`[dashboard] ${def.key} arm unavailable:`, e);
        return null;
      }),
    ),
  );
  const armsByKey: Record<string, Arm | null> = {};
  ARM_DEFS.forEach((def, i) => (armsByKey[def.key] = marked[i]));
  const focus = armsByKey[FOCUS] ?? null;
  const ordered = ARM_KEYS.map((k) => armsByKey[k]).filter((a): a is Arm => a !== null);
  // Never look back past inception: before it there are no rows, and a stretch
  // with no rows would otherwise read as the worker being offline.
  const inceptionMs = focus?.inceptionIso ? Date.parse(focus.inceptionIso) : NaN;
  const sinceMs = Math.max(nowMs - WINDOW_MS, Number.isFinite(inceptionMs) ? inceptionMs : 0);
  const worldDef = ARM_DEFS.find((d) => d.key === FOCUS && d.worldModel) ?? ARM_DEFS.find((d) => d.worldModel) ?? null;
  const agentDefs = ARM_DEFS.filter((d) => d.kind === "agent");
  const [gathered, budget, dailyBudget, toDate, pendingScores, doneScores, pending, bench, tape, letter, ops] = await Promise.all([
    gatherEvents(sinceMs),
    checkBudget(),
    dailyBudgetUsd(),
    totalSpend(),
    listScoreItems("P#"),
    listScoreItems("D#"),
    listPending().catch(() => [] as PendingOrder[]),
    benchSummaries(),
    tapeStats(),
    letterOps(),
    Promise.all(agentDefs.map((def) => armOps(def))),
  ]);
  const { curve, benchmarks } = await buildCurve(ordered, focus, nowMs);
  // Mandate status at the dashboard's own marks (the agent sees the watcher's marks; same idea).
  const mandate = focus
    ? mandateStatus(
        bookUtilization({
          cash_usd: focus.cash,
          positions: focus.positions.map((p) => ({ symbol: p.symbol, qty: p.qty, avg_cost: p.avgCost, last_seen_price: p.mark })),
        }),
        config.mandate,
        focus.positions.length ? Math.max(...focus.positions.map((p) => Math.abs(p.weightPct))) / 100 : null,
      )
    : null;
  const events = gathered.events.map((e) => compactEvent(e, isErrored(e)));
  const world =
    worldDef && armsByKey[worldDef.key]
      ? await buildWorld(tableOf(worldDef), sinceMs).catch((e) => {
          console.warn("[dashboard] world model unavailable:", e);
          return null;
        })
      : null;
  // The breaker's caps are the WORKER's config (its supervisor env), which this
  // process cannot see; the honest signal is whether the worker refused
  // anything on the current UTC budget day.
  const utcDayStart = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00Z");
  const refusals = events
    .filter((e) => e.atMs >= utcDayStart && (e.skipped || (e.suppressed && e.suppressed.kind !== "thin-book")))
    .sort((a, b) => b.atMs - a.atMs);
  const breaker = refusals[0]
    ? { at: refusals[0].at, reason: refusals[0].skipped ?? refusals[0].suppressed?.reason ?? "budget" }
    : null;
  const lastRowMs = gathered.rowMs.length > 0 ? Math.max(...gathered.rowMs) : null;
  const held = (focus?.positions ?? []).map((p) => p.symbol);
  const theses = (await getTheses(held).catch(() => [])).map((t) => ({
    symbol: t.symbol,
    at: t.latest.at,
    action: t.latest.action,
    confidence: t.latest.confidence,
    trigger: t.latest.trigger,
    rationale: t.latest.rationale,
  }));
  return {
    generatedAt: new Date(nowMs).toISOString(),
    refreshSeconds: REFRESH_MS / 1000,
    windowStartMs: sinceMs,
    arms: armsByKey,
    armKeys: ARM_KEYS,
    focusArm: FOCUS,
    worldArm: world ? worldDef!.key : null,
    world,
    curve,
    benchmarks,
    spend: {
      todayUsd: budget.costUsd,
      todayInvestigations: budget.investigations,
      dailyBudgetUsd: dailyBudget,
      newsCeilingUsd: dailyBudget * (1 - config.budgetReserveFraction),
      toDateUsd: toDate,
      allowed: !breaker,
      reason: breaker?.reason ?? null,
      trippedAtIso: breaker?.at ?? null,
    },
    worker: await workerStatus(lastRowMs ? new Date(lastRowMs).toISOString() : null),
    scores: scoreRows([...doneScores, ...pendingScores]),
    events,
    pulse: hourlyPulse(events, sinceMs, nowMs),
    gaps: coverageGaps(gathered.rowMs, sinceMs, nowMs, GAP_MS),
    theses,
    pending,
    letters: letterSummaries(),
    model: config.masterModel,
    mandate,
    orders: describeOrders(pending, nowMs),
    corrections: compactCorrections(gathered.events),
    ops: { supervisor: SUPERVISOR, arms: ops, letter, tape },
    bench,
  };
}

// ---------------------------------------------------------------------------
// Cache + refresh loop (only while someone is watching).

let cache: Overview | null = null;
let lastError: string | null = null;
let refreshing: Promise<void> | null = null;
let lastRequestMs = 0;

function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t0 = Date.now();
    try {
      cache = await buildOverview();
      lastError = null;
      console.log(`[dashboard] refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s (${cache.events.length} events)`);
    } catch (e) {
      lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error("[dashboard] refresh failed:", e);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".svg": "image/svg+xml",
};

/**
 * Serves one file from `dir` whose name is exactly `name` and matches `allow`.
 * The path opened is built from the directory listing, never from the request,
 * so no request string can name a file outside `dir`.
 */
function serveFile(res: http.ServerResponse, dir: string, name: string, allow: RegExp): void {
  let entry: string | undefined;
  try {
    entry = fs.readdirSync(dir).find((f) => f === name && allow.test(f));
  } catch {
    entry = undefined;
  }
  if (!entry) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(entry)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  fs.createReadStream(path.join(dir, entry)).pipe(res);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function startServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    lastRequestMs = Date.now();
    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return serveFile(res, STATIC_DIR, "index.html", /^index\.html$/);
      }
      if (url.pathname === "/app.js" || url.pathname === "/styles.css") {
        return serveFile(res, STATIC_DIR, url.pathname.slice(1), /^(app\.js|styles\.css)$/);
      }
      if (url.pathname.startsWith("/reports/")) {
        return serveFile(res, REPORTS_DIR, url.pathname.slice("/reports/".length), /^\d{4}-\d{2}-\d{2}\.(md|pdf|docx)$/);
      }
      if (url.pathname === "/snapshot.html") {
        // One self-contained file — page, styles and script inlined around the
        // current overview — that can be attached to an email; it needs no server.
        // `?download=1` (the header's download button) makes the browser save it.
        if (!cache) await refresh();
        if (!cache) return json(res, 503, { ok: false, warming: true, lastError });
        const read = (f: string) => fs.readFileSync(path.join(STATIC_DIR, f), "utf8");
        const page = buildStaticDashboard({
          html: read("index.html"),
          css: read("styles.css"),
          js: read("app.js"),
          overview: cache,
          exportedAtIso: new Date().toISOString(),
        });
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
        if (url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${snapshotFileName(cache.generatedAt)}"`;
        res.writeHead(200, headers);
        res.end(page);
        return;
      }
      if (url.pathname === "/api/overview") {
        if (!cache) {
          void refresh();
          return json(res, 503, { ok: false, warming: true, lastError });
        }
        return json(res, 200, { ok: true, overview: cache, refreshing: !!refreshing, lastError });
      }
      if (url.pathname === "/api/refresh") {
        await refresh();
        return json(res, cache ? 200 : 503, { ok: !!cache, lastError });
      }
      res.writeHead(404).end("not found");
    } catch (e) {
      console.error("[dashboard] request failed:", e);
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e) });
    }
  });
  server.listen(PORT, "127.0.0.1", () => {
    const tables = ARM_DEFS.map((d) => `${d.key}=${tableOf(d)}`).join(" ");
    console.log(
      `[dashboard] http://127.0.0.1:${PORT}  (focus=${FOCUS} ${tables}, supervisor=${SUPERVISOR}, refresh ${REFRESH_MS / 1000}s while viewed)`,
    );
  });
  void refresh();
  setInterval(() => {
    if (Date.now() - lastRequestMs < IDLE_AFTER_MS) void refresh();
  }, REFRESH_MS).unref();
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
