// SPDX-License-Identifier: MIT-0
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";
import { config, requireConfig } from "./config.js";
import { triage } from "./triage.js";
import { resolve } from "./quotes/resolver.js";
import { investigateAndAct } from "./pipeline.js";
import { putAudit, claimNews } from "./audit.js";
import { killSwitchOn, checkBudget, dayKey, meterTriage } from "./budget.js";
import { admitForYield, categoryOf } from "./yield-data.js";
import { yieldTableLoader } from "./yield.js";
import { rollDay, listPositions } from "./ledger.js";
import { WebSearch } from "./websearch.js";
import { scorePass } from "./score.js";
import { watchPass } from "./watch.js";
import { recentActivity as recent } from "./recent.js";
import { ensureBootstrap, triageExposures } from "./world.js";
import { curiosityPass } from "./curiosity.js";
import { snapshotSymbols, recordEventSnapshot } from "./tape.js";
import { enrichForTriage } from "./enrich.js";
import type { NewsItem } from "./types.js";

const sqs = new SQSClient({ region: config.region });

// Held symbols feed triage (news touching the book clears a lower bar). With the
// world model on, triage sees each position's established drivers instead.
let heldCache: { symbols: unknown[]; at: number } = { symbols: [], at: 0 };
async function heldSymbols(): Promise<unknown[]> {
  if (Date.now() - heldCache.at > 5 * 60_000) {
    const symbols = (await listPositions()).map((p) => p.symbol);
    heldCache = {
      symbols: config.worldModel ? await triageExposures(symbols).catch(() => symbols) : symbols,
      at: Date.now(),
    };
  }
  return heldCache.symbols;
}

/** STATE/YIELD, re-read hourly; null (flat bars) until `npm run yield -- --write` has run. */
const yieldTables = yieldTableLoader(config.table, config.yieldTriage.refreshMinutes * 60_000);
/** Sub-bar items the exploration floor admitted today, per category (resets on restart: errs toward exploring). */
const explored = new Map<string, { day: string; n: number }>();
function exploredToday(category: string): number {
  const e = explored.get(category);
  return e && e.day === dayKey() ? e.n : 0;
}
function markExplored(category: string): void {
  const day = dayKey();
  const e = explored.get(category);
  explored.set(category, e && e.day === day ? { day, n: e.n + 1 } : { day, n: 1 });
}

async function handleNews(raw: NewsItem, web: WebSearch | null): Promise<void> {
  const ageHours = (Date.now() - Date.parse(raw.published_at)) / 3.6e6;
  if (Number.isFinite(ageHours) && ageHours > config.maxNewsAgeHours) {
    return; // stale backlog (worker was offline); investigating it is wasted spend
  }
  if (!(await claimNews(raw.id))) return; // duplicate delivery

  // Identical headline within the dedupe window: not worth even a triage call.
  if (recent.isDuplicate(raw)) {
    await putAudit(raw.id, "v2-dedupe", { headline: raw.headline });
    return;
  }

  // An 8-K arrives as metadata (form, filer, item codes). Read the filing and
  // let triage see what it says (enrich.ts); non-filings pass through unchanged.
  const item = await enrichForTriage(raw);

  const held = await heldSymbols();
  const verdict = await triage(item, held, recent.recent()).catch((e) => {
    console.error(`[worker] triage failed for ${item.id}:`, e);
    return null;
  });
  if (!verdict) return;

  // Admission. Flat bars by default (held news clears a lower one — the agent
  // may need to exit); with V2_YIELD_TRIAGE=on the bar for other news moves per
  // category according to what that category has earned per LLM dollar
  // (yield-data.ts). Decided before the triage row is written so the row
  // records the bar that was applied.
  const yieldTable = config.yieldTriage.enabled ? await yieldTables.get() : null;
  const category = categoryOf(item.source_family, verdict.event_type);
  const admission = admitForYield(verdict, item.source_family, yieldTable, exploredToday(category), {
    triageThreshold: config.triageThreshold,
    heldTriageThreshold: config.heldTriageThreshold,
    explorationPerDay: config.yieldTriage.explorationPerDay,
  });
  await putAudit(item.id, "v2-triage", {
    headline: item.headline,
    ...verdict, // includes usage / cost_usd / model for the triage call (triage.ts)
    ...(item.enrichment
      ? {
          filing_summary: item.enrichment.summary,
          filing_items: item.enrichment.items,
          ...(item.enrichment.usage
            ? { enrichment_usage: item.enrichment.usage, enrichment_cost_usd: item.enrichment.cost_usd ?? 0 }
            : {}),
        }
      : {}),
    ...(config.yieldTriage.enabled
      ? { yield: { ...admission, table_at: yieldTable?.computedAtIso ?? null } }
      : {}),
  });
  // Triage + enrichment dollars into the daily breaker — only under V2_METER_TRIAGE (budget.ts).
  await meterTriage(item, verdict);

  // Quote tape: price the hinted instruments NOW, for every triaged item (the
  // bench tests thresholds below the live bar), so the replay can resolve
  // as-of the event. Started before the investigation so the capture is
  // genuinely as-of; awaited (10 s cap) only when the event goes on to be
  // investigated, otherwise left to finish in the background. The triage
  // verdict carries no symbol fields (hypotheses are prose), so tickers_hint
  // is the whole list. Never allowed to throw into the handler.
  const tapeSymbols = [...new Set((item.tickers_hint ?? []).map((s) => s.trim()).filter(Boolean))];
  const snapshot = snapshotSymbols(tapeSymbols, item.id).catch(() => [] as string[]);
  recordEventSnapshot(item, verdict, tapeSymbols).catch(() => {});

  if (!admission.admitted) {
    // Only a yield decision is worth a row: an item under the flat bar is
    // ordinary triage and the letter already counts those from the triage rows.
    if (config.yieldTriage.enabled && verdict.materiality >= admission.baseThreshold) {
      console.log(`[worker] yield-triage skip ${item.id}: ${admission.reason}`);
      await putAudit(item.id, "v2-skipped", { reason: `yield-triage: ${admission.reason}` });
    }
    return;
  }
  if (admission.explored) markExplored(category);

  const budget = await checkBudget();
  if (!budget.allowed) {
    console.warn(`[worker] skipping ${item.id}: ${budget.reason}`);
    await putAudit(item.id, "v2-skipped", { reason: budget.reason });
    return;
  }

  console.log(
    `[worker] investigating ${item.id} (materiality ${verdict.materiality}` +
      `${verdict.touches_positions ? ", touches book" : ""}): ${item.headline}`,
  );
  await snapshot;
  await investigateAndAct(item, verdict.hypotheses, web);
  heldCache.at = 0; // decision may have changed the book
}

function parseEnvelope(body: string): NewsItem | null {
  try {
    const ev = JSON.parse(body);
    if (ev["detail-type"] !== "NewsItem") return null;
    return ev.detail as NewsItem;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  requireConfig(["queueUrl"]);
  console.log(
    `[worker] fin ${config.arm} starting — table=${config.table} dryRun=${config.dryRun} ` +
      `model=${config.masterModel} maxTurns=${config.maxTurns} effort=${config.effort ?? "default(high)"} worldModel=${config.worldModel}`,
  );
  if (config.worldModel) {
    await ensureBootstrap().catch((e) => console.error("[worker] world-model bootstrap failed:", e));
  }
  const web = await WebSearch.start();
  if (!web) console.warn("[worker] no web search — investigations run degraded");
  let lastScorePass = 0;
  let lastWatchPass = 0;
  let lastCuriosityPass = Date.now(); // first pass after one interval, not at boot
  for (;;) {
    try {
      await rollDay(dayKey());
      if (Date.now() - lastScorePass > 15 * 60_000) {
        lastScorePass = Date.now();
        const s = await scorePass(resolve);
        if (s.scored + s.expired + s.completed > 0) {
          console.log(
            `[worker] scorePass: scored=${s.scored} expired=${s.expired} completed=${s.completed}`,
          );
        }
      }
      // Event-driven selling: price moves + settlement + the daily review.
      if (Date.now() - lastWatchPass > 5 * 60_000) {
        lastWatchPass = Date.now();
        if (!(await killSwitchOn())) {
          await watchPass(web);
          heldCache.at = 0;
        }
      }
      // v3: the world model asks its own questions (contradictions, gaps, staleness).
      if (config.worldModel && Date.now() - lastCuriosityPass > config.curiosityIntervalMin * 60_000) {
        lastCuriosityPass = Date.now();
        if (!(await killSwitchOn())) {
          await curiosityPass(web).catch((e) => console.error("[worker] curiosity pass failed:", e));
          heldCache.at = 0;
        }
      }
      const r = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: config.queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
        }),
      );
      for (const msg of r.Messages ?? []) {
        if (await killSwitchOn()) {
          console.warn("[worker] kill switch is ON; leaving messages in queue");
          await new Promise((res) => setTimeout(res, 30_000));
          break;
        }
        const item = parseEnvelope(msg.Body ?? "");
        try {
          if (item) await handleNews(item, web);
          await sqs.send(
            new DeleteMessageCommand({
              QueueUrl: config.queueUrl,
              ReceiptHandle: msg.ReceiptHandle!,
            }),
          );
        } catch (e) {
          // leave the message; visibility timeout retries it, DLQ after 3
          console.error(`[worker] failed handling ${item?.id ?? "unparseable"}:`, e);
        }
      }
    } catch (e) {
      // transient AWS/credential failures: back off and keep the process alive
      console.error("[worker] loop error (retrying in 30s):", e);
      await new Promise((res) => setTimeout(res, 30_000));
    }
  }
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
