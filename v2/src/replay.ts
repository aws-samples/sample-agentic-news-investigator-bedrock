// SPDX-License-Identifier: MIT-0
import {
  EventBridgeClient,
  DescribeRuleCommand,
  EnableRuleCommand,
  DisableRuleCommand,
  StartReplayCommand,
  DescribeReplayCommand,
  DescribeArchiveCommand,
} from "@aws-sdk/client-eventbridge";
import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
} from "@aws-sdk/client-sqs";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { config, arms } from "./config.js";
import { ddb } from "./ledger.js";
import { triage } from "./triage.js";
import { enrichForTriage } from "./enrich.js";
import { putAudit } from "./audit.js";
import { addSpend } from "./budget.js";
import { resolveAsOf, historicalReturn } from "./quotes/asof.js";
import { quoteAsOf } from "./tape.js";
import { getStrategy, parseVariantList } from "./strategy.js";
import { runVariant, type BenchEvent, type BenchRow, type VariantRun } from "./bench/run.js";
import {
  corpusHash,
  itemsHash,
  publicDomainItems,
  readCorpus,
  readSidecarHash,
  selectEvents,
  toBenchEvent,
  windowOf,
  writeCorpus,
  type CorpusHeader,
} from "./bench/corpus.js";
import {
  corpusKey,
  diffRuns,
  filterSummaries,
  formatCompareTable,
  formatDiff,
  parseRunSelectors,
  recordsFrom,
  runKeyOf,
  sameCorpus,
  summariesFrom,
  type AuditItem,
} from "./bench/compare.js";
import { computeYieldTable } from "./yield.js";
import { admitForYield, categoryOf, renderYieldTable } from "./yield-data.js";
import type { NewsItem } from "./types.js";

/**
 * The benchmark (LongVideoAgent's LongTVQA move, transplanted): run archived
 * NewsItems through triage, then run one or more decision-layer VARIANTS
 * (strategy.ts) over the same events, each against its own simulated book that
 * carries across events (bench/run.ts + bench/book.ts), and score every
 * decision against the prices that actually followed. Summaries are keyed by
 * bench name and variant so prompts and structures can be compared
 * run-over-run and side by side.
 *
 * Two input modes, one bench:
 *  - ARCHIVE (default): drain a window of the fin-events 90-day archive through
 *    the dedicated replay rule and queue. One bench at a time (they share the rule).
 *  - CORPUS (`--corpus <file>`): read a JSONL corpus (bench/corpus.ts) — no
 *    EventBridge, no SQS, no shared state — so any number of benches can run at
 *    once, and every BENCHSUM row records the corpus file's sha256, which is
 *    what makes two runs comparable event by event.
 *  `--dump <file>` drains the archive into a corpus file and exits: no triage,
 *  no spend. `--compare` / `--diff` read BENCHSUM and BENCH# rows only.
 *
 * Isolation properties:
 *  - The replay is delivered ONLY to the dedicated (normally disabled) rule
 *    via StartReplay Destination.FilterArns.
 *  - Only envelopes carrying `replay-name` are processed, so live events that
 *    leak in while the rule is briefly enabled are dropped.
 *  - Decisions are never executed live; fills land on the in-memory SimBook.
 *    Audits/summaries live under BENCH#/BENCHSUM, spend under BENCH#<name>#<variant>.
 *  - Web search is OFF: the live web knows the future of an archived event
 *    (lookahead bias), so the bench measures the degraded agent by design.
 *  - Primary sources are ON (`read_source`): an SEC filing addressed by
 *    accession and an archived body are what the event pointed at when it was
 *    published, so reading them is not lookahead; the live url is refused.
 *  - Quotes are AS-OF THE EVENT (since 2026-09-04): resolve_instrument and
 *    search_markets answer from the quote tape (tape.ts) when it has a row,
 *    else from Yahoo history (quotes/asof.ts), never live. The clock is the
 *    event's own time. Portfolio and decision-history tools read the sim book
 *    and this run's own prior decisions, never the live ledger or THESIS# rows
 *    (those hold rationales written after the event).
 *
 * Usage:
 *   node dist/replay.js --name bench-X --max 20 --days 7 --end-days-ago 7 \
 *     [--variants live,no-mandate] [--threshold 0.45] [--budget-usd 10] \
 *     [--seed-cash 100000] [--max-events 200] [--overwrite]
 *     [--guardrail-id <id> --guardrail-version <n>]   (required by --variants …,guardrail)
 *   node dist/replay.js --dump bench/corpus/week.jsonl --days 7 --end-days-ago 7 [--public-domain] [--note "…"]
 *   node dist/replay.js --corpus bench/corpus/week.jsonl --name bench-X [--variants a,b] [--max 20] …
 *   node dist/replay.js --compare [--names a,b#terse]
 *   node dist/replay.js --compare --diff a[#variant] b[#variant] [--all]
 * `--budget-usd` and `--max` are PER VARIANT. In archive mode always pass
 * --days and --end-days-ago: two summaries with the same window_days can cover
 * disjoint weeks. In corpus mode the window is the corpus's own.
 */

// The archive-replay plumbing is shared by all arms and named from the registry
// prefix by the parameterised stack (infra/lib/names.ts): <prefix>-events,
// <prefix>-replay-rule, <prefix>-replay, <prefix>-events-archive. The stack's
// ReplayQueueUrl / ReplayRuleName outputs (and the ArmsEnv block) carry the
// deployed values; V2_* env overrides them. Corpus mode (--corpus) touches none of this.
const PREFIX = arms.prefix;
const BUS = process.env.V2_EVENT_BUS ?? `${PREFIX}-events`;
const RULE = process.env.V2_REPLAY_RULE ?? `${PREFIX}-replay-rule`;
const QUEUE = process.env.V2_REPLAY_QUEUE ?? `${PREFIX}-replay`;
const ARCHIVE = process.env.V2_EVENT_ARCHIVE ?? `${PREFIX}-events-archive`;
const DAY_MS = 86_400_000;

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : fallback;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function nums(rows: BenchRow[], key: "ret_1d" | "ret_7d"): number[] {
  return rows.map((r) => r[key]).filter((x): x is number => typeof x === "number");
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function fmtPct(x: number | null | undefined): string {
  return typeof x === "number" ? `${(x * 100).toFixed(2)}%` : "n/a";
}

// ---------------------------------------------------------------------------
// Phase 0 (archive mode): drain a window of the archive into memory.
// ---------------------------------------------------------------------------

/**
 * Replays [start, end) of the archive into the dedicated rule + queue and
 * drains it. The only place in this file that touches EventBridge or SQS; the
 * corpus mode never calls it, so it never enables the rule or purges the queue.
 */
async function drainArchive(name: string, start: Date, end: Date, maxEvents: number): Promise<NewsItem[]> {
  const eb = new EventBridgeClient({ region: config.region });
  const sqs = new SQSClient({ region: config.region });

  const rule = await eb.send(new DescribeRuleCommand({ Name: RULE, EventBusName: BUS }));
  const ruleArn = rule.Arn!;
  const account = ruleArn.split(":")[4];
  const busArn = `arn:aws:events:${config.region}:${account}:event-bus/${BUS}`;
  // DescribeArchive by name, not ListArchives: it is scoped to the one archive
  // in the stack's WorkerPolicy, where ListArchives would need Resource "*".
  const archive = await eb
    .send(new DescribeArchiveCommand({ ArchiveName: ARCHIVE }))
    .catch((e: Error) => {
      throw new Error(`archive ${ARCHIVE} not found: ${e.message}`);
    });
  if (archive.EventSourceArn !== busArn) throw new Error(`archive ${ARCHIVE} is not on ${busArn}`);
  const archiveArn = archive.ArchiveArn ?? `arn:aws:events:${config.region}:${account}:archive/${ARCHIVE}`;
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE }));

  // Drop leftovers from any interrupted previous bench.
  await sqs.send(new PurgeQueueCommand({ QueueUrl })).catch(() => {});
  await eb.send(new EnableRuleCommand({ Name: RULE, EventBusName: BUS }));

  // A killed bench must never leave the rule enabled (live events would
  // stream into the replay queue).
  const disableRule = () => eb.send(new DisableRuleCommand({ Name: RULE, EventBusName: BUS }));
  const onSignal = () => {
    disableRule()
      .then(() => console.log("[replay] rule disabled (signal)"))
      .finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const items: NewsItem[] = [];
  try {
    const replay = await eb.send(
      new StartReplayCommand({
        ReplayName: `${name}-${Date.now()}`,
        EventSourceArn: archiveArn,
        EventStartTime: start,
        EventEndTime: end,
        Destination: { Arn: busArn, FilterArns: [ruleArn] },
      }),
    );
    console.log(`[replay] started: ${replay.ReplayArn}`);

    let emptyPolls = 0;
    let replayDone = false;
    while (emptyPolls < 3 && items.length < maxEvents) {
      const r = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 10,
        }),
      );
      const msgs = r.Messages ?? [];
      if (msgs.length === 0) {
        if (!replayDone) {
          const d = await eb.send(
            new DescribeReplayCommand({ ReplayName: replay.ReplayArn!.split("/").pop()! }),
          );
          replayDone = d.State === "COMPLETED" || d.State === "FAILED" || d.State === "CANCELLED";
          if (d.State === "FAILED") console.error(`[replay] replay FAILED: ${d.StateReason}`);
        } else {
          emptyPolls++;
        }
        continue;
      }
      emptyPolls = 0;
      for (const msg of msgs) {
        try {
          const envelope = JSON.parse(msg.Body ?? "{}");
          // Drop non-replay leaks (live events while the rule is enabled).
          if (envelope["replay-name"] && envelope["detail-type"] === "NewsItem") {
            items.push(envelope.detail as NewsItem);
          }
        } catch {
          // unparseable: deleted below
        }
        await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: msg.ReceiptHandle! }));
      }
      console.log(`[replay] drained ${items.length} events`);
    }
  } finally {
    await disableRule();
    console.log("[replay] rule disabled");
  }
  return items;
}

// ---------------------------------------------------------------------------
// Phase 1: triage (shared across variants)
// ---------------------------------------------------------------------------

async function triageEvent(raw: NewsItem, benchName: string, threshold: number): Promise<BenchEvent> {
  // Same pre-triage step as the worker: a filing is read by accession (immutable,
  // so no lookahead) and summarized before triage sees it.
  const item = await enrichForTriage(raw, { log: () => {} });
  const verdict = await triage(item);
  await putAudit(
    `${benchName}#${item.id}`,
    "bench-triage",
    {
      headline: item.headline,
      published_at: item.published_at,
      source_family: item.source_family,
      ...verdict,
      ...(item.enrichment ? { filing_summary: item.enrichment.summary, filing_items: item.enrichment.items } : {}),
    },
    { pkPrefix: "BENCH#" },
  );
  return toBenchEvent(item, verdict, threshold);
}

// ---------------------------------------------------------------------------
// The bench proper: triage once, then each variant on its own book.
// ---------------------------------------------------------------------------

interface BenchInput {
  items: NewsItem[];
  input: "archive" | "corpus";
  start: Date;
  end: Date;
  /** Recorded on BENCHSUM; null in archive mode. */
  corpusFile: string | null;
  corpusHash: string | null;
  header: CorpusHeader | null;
}

interface BenchOptions {
  name: string;
  variants: string[];
  maxInvestigations: number;
  threshold: number;
  budgetUsd: number;
  seedCash: number;
}

/** Fail before any spend when a summary already exists under this name#variant (a re-run would overwrite it). */
async function assertFreshRun(name: string, variants: string[], overwrite: boolean): Promise<void> {
  for (const v of variants) {
    const sk = `${name}#${v}`;
    const r = await ddb.send(new GetCommand({ TableName: config.table, Key: { pk: "BENCHSUM", sk } }));
    if (r.Item && !overwrite) {
      throw new Error(`BENCHSUM ${sk} already exists (ran ${r.Item.ran_at ?? "?"}); pick a new --name or pass --overwrite`);
    }
  }
}

async function runBench(inp: BenchInput, opts: BenchOptions): Promise<void> {
  const { name, variants, maxInvestigations, threshold, budgetUsd, seedCash } = opts;
  const { items, start, end } = inp;
  // Fail fast on an unknown variant, before any spend.
  const strategies = variants.map((v) => getStrategy(v));

  // The yield-triage variant needs the table as of the window START: decisions
  // taken inside the window, and 7-day scores that only matured inside it, are
  // lookahead. --yield-until overrides the cutoff.
  for (const s of strategies) {
    if (s.name !== "yield-triage") continue;
    const untilRaw = arg("yield-until", "");
    const untilMs = untilRaw ? Date.parse(untilRaw) : inp.start.getTime();
    if (!Number.isFinite(untilMs)) throw new Error(`bad --yield-until ${untilRaw}`);
    const table = await computeYieldTable(config.table, { nowMs: untilMs });
    console.log(`[replay] yield table as of ${new Date(untilMs).toISOString()}\n${renderYieldTable(table)}`);
    const explored = new Map<string, number>();
    s.admit = (ev) => {
      const key = `${categoryOf(ev.item.source_family, ev.eventType)}|${String(ev.item.published_at).slice(0, 10)}`;
      const a = admitForYield(
        { materiality: ev.materiality, touches_positions: ev.touchesPositions ?? false, event_type: ev.eventType },
        ev.item.source_family,
        table,
        explored.get(key) ?? 0,
        { triageThreshold: opts.threshold, heldTriageThreshold: config.heldTriageThreshold, explorationPerDay: config.yieldTriage.explorationPerDay },
      );
      if (a.admitted && a.explored) explored.set(key, (explored.get(key) ?? 0) + 1);
      return a;
    };
  }

  await assertFreshRun(name, variants, has("overwrite"));
  const days = (end.getTime() - start.getTime()) / DAY_MS;
  const endDaysAgo = (Date.now() - end.getTime()) / DAY_MS;
  // What was actually run (after --max-events), so a truncated run never
  // compares as identical to a full one on the same file.
  const corpusItemsHash = itemsHash(items);

  console.log(
    `[replay] bench=${name} input=${inp.input}${inp.corpusFile ? ` corpus=${inp.corpusFile} sha256=${inp.corpusHash}` : ""} ` +
      `window=${start.toISOString()}..${end.toISOString()} events=${items.length} ` +
      `variants=${variants.join(",")} maxInvestigations=${maxInvestigations}/variant budget=$${budgetUsd}/variant`,
  );

  // Phase 1: triage every event once, concurrently (cheap Haiku calls); shared by all variants.
  const events = await mapLimit(items, 8, (item) =>
    triageEvent(item, name, threshold).catch((e) => {
      console.error(`[replay] triage failed for ${item.id}:`, e);
      return null;
    }),
  );
  const triaged = events.filter((e): e is BenchEvent => e !== null);
  const passing = triaged.filter((e) => e.passed).length;
  console.log(`[replay] triaged ${triaged.length} events; ${passing} clear threshold ${threshold}`);

  // Phase 2: each variant walks the same events, chronologically, on its own book.
  const tape = (symbol: string, asOfMs: number) => quoteAsOf(symbol, asOfMs);
  const runs: VariantRun[] = [];
  for (const strategy of strategies) {
    console.log(`\n[replay] === variant ${strategy.name}: ${strategy.description}`);
    const run = await runVariant(
      strategy,
      triaged,
      { benchName: name, seedCash, maxInvestigations, budgetUsd, windowEndMs: end.getTime() },
      {
        resolveAsOf: (s, k, ms) => resolveAsOf(s, k, ms, { tape }),
        historicalReturn: (s, k, a, e, h) => historicalReturn(s, k, a, e, h, { tape }),
        audit: (id, stage, payload) => putAudit(id, stage, payload, { pkPrefix: "BENCH#" }),
        addSpend: (usd) => addSpend(usd, { scope: `BENCH#${name}#${strategy.name}` }),
        log: console.log,
      },
    );
    runs.push(run);

    const decided = run.rows.filter((r) => r.action && !r.errored);
    const trades = decided.filter((r) => r.action !== "hold");
    const holds = decided.filter((r) => r.action === "hold");
    const summary = {
      bench: name,
      variant: run.variant,
      description: run.description,
      arm: config.arm,
      // Inputs. `input` says where the events came from; the hashes say WHICH
      // events (bench/corpus.ts): corpus_hash is the file's bytes (null when
      // drained from the archive), corpus_items_hash the canonical lines that
      // were actually run. compare.ts refuses a per-event diff across different ones.
      input: inp.input,
      corpus_file: inp.corpusFile,
      corpus_hash: inp.corpusHash,
      corpus_items_hash: corpusItemsHash,
      corpus_source: inp.header?.source ?? null,
      corpus_created_at: inp.header?.created_at ?? null,
      corpus_count: inp.header?.count ?? null,
      window_days: Math.round(days * 100) / 100,
      // Without these two, a summary cannot be compared to another one: `--days 7
      // --end-days-ago 7` and `--days 7` are both "window_days: 7" over completely
      // disjoint weeks.
      end_days_ago: Math.round(endDaysAgo * 10) / 10,
      window: `${start.toISOString()}..${end.toISOString()}`,
      events_seen: items.length,
      triage_passed: passing,
      decided: decided.length,
      buys: trades.filter((r) => r.action === "buy").length,
      sells: trades.filter((r) => r.action === "sell").length,
      holds: holds.length,
      errored: run.errored,
      filled: trades.filter((r) => r.fill).length,
      dropped: trades.filter((r) => r.dropped).length,
      cost_usd: run.cost_usd,
      trade_mean_ret_1d: mean(nums(trades, "ret_1d")),
      trade_mean_ret_7d: mean(nums(trades, "ret_7d")),
      hold_counterfactual_ret_1d: mean(nums(holds, "ret_1d")),
      unscoreable: decided.filter((r) => r.symbol && r.scoreable === false).length,
      book: run.book,
      stopped_reason: run.stopped_reason ?? null,
      triage_threshold: threshold,
      book_context: "sim-book-carried+mandate",
      seed_cash: seedCash,
      budget_usd: budgetUsd, // per variant
      search_disabled: true, // by design: no lookahead
      primary_sources: true,
      // Filings are summarized from their own text before triage (enrich.ts), since 2026-09-04.
      triage_enrichment: "8k-filing-summary",
      clock: "event-time",
      quotes: "as-of-event (tape, then yahoo history)",
      scoring: "as-of entry/exit via historicalReturn",
      audit_prefix: "BENCH#",
      spend_scope: `BENCH#${name}#${run.variant}`,
      residual_bias:
        "search is OFF, so a hold can mean unresearchable rather than unattractive. " +
        "The quote tape starts 2026-09-04: before that, prediction contracts and parallel " +
        "USDT rates have no as-of price (unscoreable) and equities/FX/crypto/futures resolve " +
        "from Yahoo bars, which carry no bid/ask or depth — fills take the 2 bps adverse " +
        "model and the liquidity cap cannot bind. The sim book starts from seed cash: no " +
        "live theses, pending orders or positions are carried in.",
      ran_at: new Date().toISOString(),
    };
    await ddb.send(
      new PutCommand({
        TableName: config.table,
        Item: { pk: "BENCHSUM", sk: `${name}#${run.variant}`, ...summary },
      }),
    );
    console.log(`\n[replay] summary ${name}#${run.variant}:`);
    console.log(JSON.stringify(summary, null, 2));
    for (const r of decided) {
      console.log(
        `  ${(r.action ?? "-").padEnd(4)} ${(r.symbol ?? "-").padEnd(12)} ` +
          `1d ${fmtPct(r.ret_1d).padStart(8)} 7d ${fmtPct(r.ret_7d).padStart(8)}` +
          (r.fill ? `  filled ${r.fill.side} ${r.fill.qty} @ ${r.fill.fillPrice}` : r.dropped ? `  ${r.dropped}` : "") +
          `  ${r.headline}`,
      );
    }
  }

  if (runs.length > 1) {
    console.log(`\n[replay] comparison (${name}, ${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}):`);
    const header = ["variant", "inv", "buys", "sells", "holds", "ret_1d", "ret_7d", "equity", "cost"];
    const table = runs.map((run) => {
      const decided = run.rows.filter((r) => r.action && !r.errored);
      const trades = decided.filter((r) => r.action !== "hold");
      return [
        run.variant,
        String(run.investigations),
        String(trades.filter((r) => r.action === "buy").length),
        String(trades.filter((r) => r.action === "sell").length),
        String(decided.filter((r) => r.action === "hold").length),
        fmtPct(mean(nums(trades, "ret_1d"))),
        fmtPct(mean(nums(trades, "ret_7d"))),
        run.book.final_equity.toFixed(0),
        `$${run.cost_usd.toFixed(2)}`,
      ];
    });
    const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
    const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
    console.log("  " + fmt(header));
    for (const row of table) console.log("  " + fmt(row));
  }
  console.log(`\n[replay] compare with: node dist/replay.js --compare --names ${name}`);
}

// ---------------------------------------------------------------------------
// --compare / --diff: read-only over BENCHSUM and BENCH# rows.
// ---------------------------------------------------------------------------

async function queryAllBenchSummaries(): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: config.table,
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": "BENCHSUM" },
        ExclusiveStartKey,
      }),
    );
    out.push(...((r.Items ?? []) as Array<Record<string, unknown>>));
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}

/** Every BENCH#<name>#… audit row for the given bench names (a filtered scan: audit pks are one per event). */
async function scanBenchAudits(names: string[]): Promise<AuditItem[]> {
  const uniq = [...new Set(names)];
  const values: Record<string, string> = {};
  const clauses = uniq.map((n, i) => {
    values[`:p${i}`] = `BENCH#${n}#`;
    return `begins_with(pk, :p${i})`;
  });
  const out: AuditItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: config.table,
        FilterExpression: clauses.join(" OR "),
        ExpressionAttributeValues: values,
        ProjectionExpression: "pk, sk, stage, payload",
        ExclusiveStartKey,
      }),
    );
    out.push(...((r.Items ?? []) as AuditItem[]));
    ExclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (++pages % 10 === 0) console.error(`[compare] scanned ${pages} pages, ${out.length} bench rows so far…`);
  } while (ExclusiveStartKey);
  return out;
}

async function compareMain(): Promise<void> {
  const summaries = summariesFrom(await queryAllBenchSummaries());
  const diffIdx = process.argv.indexOf("--diff");
  if (diffIdx < 0) {
    const selectors = parseRunSelectors(arg("names", ""));
    const rows = filterSummaries(summaries, selectors);
    if (selectors.length > 0 && rows.length === 0) {
      console.error(`[compare] no BENCHSUM rows match ${selectors.join(", ")}; known runs: ${summaries.map((s) => s.runKey).join(", ") || "(none)"}`);
      process.exit(1);
    }
    console.log(formatCompareTable(rows));
    return;
  }

  const selA = process.argv[diffIdx + 1];
  const selB = process.argv[diffIdx + 2];
  if (!selA || !selB || selA.startsWith("--") || selB.startsWith("--")) {
    throw new Error("usage: --compare --diff <name[#variant]> <name[#variant]> [--all]");
  }
  const a = runKeyOf(selA);
  const b = runKeyOf(selB);
  if (a.runKey === b.runKey) throw new Error(`--diff needs two different runs (got ${a.runKey} twice)`);
  const sa = summaries.find((s) => s.runKey === a.runKey);
  const sb = summaries.find((s) => s.runKey === b.runKey);
  for (const [key, s] of [[a.runKey, sa], [b.runKey, sb]] as const) {
    if (!s) throw new Error(`no BENCHSUM row for ${key}; known runs: ${summaries.map((x) => x.runKey).join(", ") || "(none)"}`);
  }
  if (!sameCorpus(sa!, sb!)) {
    throw new Error(
      `refusing to diff: ${a.runKey} ran on inputs ${corpusKey(sa!) ?? "(unrecorded)"} (${sa!.eventsSeen} events) and ` +
        `${b.runKey} on ${corpusKey(sb!) ?? "(unrecorded)"} (${sb!.eventsSeen} events). A per-event diff needs identical inputs: ` +
        "run both from the same --corpus file with the same --max-events.",
    );
  }
  console.error(`[compare] reading BENCH# rows for ${a.name}${a.name !== b.name ? ` and ${b.name}` : ""}…`);
  const audits = await scanBenchAudits([a.name, b.name]);
  const ra = recordsFrom(audits, a, sa!.threshold);
  const rb = recordsFrom(audits, b, sb!.threshold);
  console.log(formatDiff(diffRuns(ra, rb), { a: a.runKey, b: b.runKey }, { all: has("all") }));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (has("compare") || has("diff")) return compareMain();

  const dumpFile = arg("dump", "");
  const corpusFile = arg("corpus", "");
  if (dumpFile && corpusFile) throw new Error("--dump and --corpus are exclusive: dump writes a corpus, corpus reads one");

  const name = arg("name", `bench-${new Date().toISOString().slice(0, 10)}`);
  const maxInvestigations = Number(arg("max", "20"));
  // A dump wants the whole window; a bench caps what it will triage.
  const maxEvents = Number(arg("max-events", dumpFile ? "100000" : "200"));
  const days = Number(arg("days", "7"));
  // End the window >=7 days in the past to get full ret_7d scoring.
  const endDaysAgo = Number(arg("end-days-ago", "0"));
  // What the bench is testing: the live triage bar by default, or a hypothesis.
  const threshold = Number(arg("threshold", String(config.triageThreshold)));
  // Each variant's own spend ceiling — never the live breaker.
  const budgetUsd = Number(arg("budget-usd", "10"));
  const seedCash = Number(arg("seed-cash", "100000"));
  const variants = parseVariantList(arg("variants", ""));
  // The `guardrail` variant's guardrail (strategy.ts guardrailStrategy). Only
  // that variant uses it; triage and every other variant stay unguarded.
  const benchGuardrailId = arg("guardrail-id", "");
  const benchGuardrailVersion = arg("guardrail-version", "");
  if (benchGuardrailId) process.env.V2_BENCH_GUARDRAIL_ID = benchGuardrailId;
  if (benchGuardrailVersion) process.env.V2_BENCH_GUARDRAIL_VERSION = benchGuardrailVersion;
  if (config.guardrailId) {
    console.warn(
      "[bench] V2_GUARDRAIL_ID is set: triage, filing summaries and EVERY variant run behind the guardrail, " +
        "so the guardrail variant differs from live in nothing. Unset it to measure the guardrail.",
    );
  }

  // ---- --dump: archive -> corpus file. No triage, no spend, exits.
  if (dumpFile) {
    const end = new Date(Date.now() - endDaysAgo * DAY_MS);
    const start = new Date(end.getTime() - days * DAY_MS);
    console.log(`[dump] window=${start.toISOString()}..${end.toISOString()} -> ${dumpFile}`);
    const drained = await drainArchive(name, start, end, maxEvents);
    let items = drained;
    if (has("public-domain")) {
      items = publicDomainItems(drained);
      console.log(`[dump] public-domain filter: kept ${items.length} of ${drained.length} (edgar/disaster only, no wire or crypto press)`);
    }
    const note = arg("note", has("public-domain") ? "public-domain source families only (SEC EDGAR, USGS, NHC, GDACS)" : "");
    const w = await writeCorpus(dumpFile, items, {
      source: "archive",
      window: { start: start.toISOString(), end: end.toISOString() },
      ...(note ? { note } : {}),
    });
    console.log(`[dump] wrote ${w.count} items to ${w.path}\n[dump] sha256 ${w.hash} (sidecar ${w.path}.sha256)\n[dump] items hash ${w.itemsHash}`);
    console.log(`[dump] run it: node dist/replay.js --corpus ${dumpFile} --name <bench> --variants live,no-mandate`);
    return;
  }

  // ---- --corpus: file -> bench. Never touches EventBridge or SQS.
  if (corpusFile) {
    const corpus = await readCorpus(corpusFile);
    const hash = await corpusHash(corpusFile);
    const sidecar = await readSidecarHash(corpusFile);
    if (sidecar && sidecar !== hash) {
      console.warn(`[replay] WARNING: ${corpusFile}.sha256 says ${sidecar} but the file hashes to ${hash}; the file was edited after its sidecar was written`);
    }
    if (has("days") || has("end-days-ago")) {
      console.log("[replay] note: --days/--end-days-ago are ignored in corpus mode; the window is the corpus's own");
    }
    const items = selectEvents(corpus.items, { maxEvents });
    const eventSpan = windowOf(items);
    if (!eventSpan) throw new Error(`${corpusFile}: no events with a parseable published_at`);
    // The window is the corpus's own (header), else the events' span. A window
    // that ends ON its last event would mark the book at the moment of the last
    // decision and never fill an order parked at it, so pad such an end by a day.
    const declared = corpus.header.window.start && corpus.header.window.end ? corpus.header.window : null;
    const start = new Date(declared?.start ?? eventSpan.start);
    const lastEventMs = Date.parse(eventSpan.end);
    let endMs = declared ? Date.parse(declared.end) : lastEventMs + DAY_MS;
    if (!(endMs > lastEventMs)) endMs = lastEventMs + DAY_MS;
    const end = new Date(endMs);
    if (items.length < corpus.items.length) {
      console.log(`[replay] --max-events ${maxEvents}: running the first ${items.length} of ${corpus.items.length} events (chronological)`);
    }
    console.log(`[replay] corpus ${corpusFile}: ${corpus.items.length} items, source=${corpus.header.source}, created ${corpus.header.created_at}${corpus.header.note ? `, note: ${corpus.header.note}` : ""}`);
    await runBench(
      { items, input: "corpus", start, end, corpusFile, corpusHash: hash, header: corpus.header },
      { name, variants, maxInvestigations, threshold, budgetUsd, seedCash },
    );
    return;
  }

  // ---- default: archive -> bench (the original front door).
  // Fail fast on an unknown variant, before any AWS call.
  variants.forEach((v) => getStrategy(v));
  const end = new Date(Date.now() - endDaysAgo * DAY_MS);
  const start = new Date(end.getTime() - days * DAY_MS);
  const items = await drainArchive(name, start, end, maxEvents);
  await runBench(
    { items, input: "archive", start, end, corpusFile: null, corpusHash: null, header: null },
    { name, variants, maxInvestigations, threshold, budgetUsd, seedCash },
  );
}

main().catch((e) => {
  console.error("[replay] fatal:", e);
  process.exit(1);
});
