// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import { investigate } from "./investigate.js";
import { resolve } from "./quotes/resolver.js";
import { executeDecision } from "./exec.js";
import { putAudit } from "./audit.js";
import { addSpend } from "./budget.js";
import { enqueueScore, entryPrice } from "./score.js";
import { getPortfolio, listPositions } from "./ledger.js";
import { getTheses, recordThesis } from "./thesis.js";
import {
  savePending,
  cancelPending,
  listPending,
  PARKABLE_REASONS,
  remainderAfter,
  isReduction,
  positionAfterFill,
  type PendingOrder,
} from "./pending.js";
import { worldModelFor, renderWorldModel } from "./world.js";
import { recentActivity } from "./recent.js";
import { bookUtilization, renderMandate } from "./mandate.js";
import type { WebSearch } from "./websearch.js";
import type { NewsItem, TradeDecision } from "./types.js";

/**
 * Compact book + standing-theses context pushed into every investigation.
 * Prices come from the watcher's last pass (no extra quote calls); the agent
 * resolves live quotes itself when it cares.
 */
async function buildBookContext(): Promise<string> {
  const [portfolio, positions] = await Promise.all([getPortfolio(), listPositions()]);
  const theses = await getTheses(positions.map((p) => p.symbol));
  const book = {
    cash_usd: portfolio?.cash ?? null,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      kind: p.kind,
      qty: p.qty,
      avg_cost: p.avg_cost,
      last_seen_price: p.last_watch_price ?? null,
    })),
  };
  const parts = [JSON.stringify(book)];
  // What the book is FOR, and what it already looked at and left on the table
  // (mandate.ts). Held symbols are excluded from the watchlist: those have
  // standing theses below.
  const held = new Set(positions.map((p) => p.symbol));
  parts.push(
    renderMandate(
      bookUtilization(book),
      recentActivity.watchlist().filter((w) => !held.has(w.symbol)),
    ),
  );
  if (theses.length > 0) {
    parts.push(
      "Standing theses (why each position was opened / last re-underwritten):",
      JSON.stringify(theses.map((t) => ({ symbol: t.symbol, ...t.latest }))),
    );
  }
  if (config.worldModel && positions.length > 0) {
    const wm = await worldModelFor(positions.map((p) => p.symbol)).catch((e) => {
      console.error("[pipeline] world model failed:", e);
      return null;
    });
    if (wm) {
      parts.push(
        "World model for the held book (facts, drivers, exposure links; STALE/EXPIRED flagged — correct what is wrong):",
        renderWorldModel(wm),
      );
    }
  }
  const pending = await listPending();
  if (pending.length > 0) {
    parts.push(
      "Pending orders — parked for venue open / limit, or (working: true) the remainder of a liquidity-capped exit still being sold in slices of 25% of the visible book, one slice per hour. A new buy/sell decision on the same symbol supersedes:",
      JSON.stringify(
        pending.map((o) => ({
          symbol: o.symbol,
          side: o.side,
          notional_usd: o.notional_usd,
          limit_price: o.limit_price ?? null,
          expires_at: o.expires_at,
          parked_reason: o.parked_reason,
          ...(o.reduce_only
            ? { working: true, requested_usd: o.requested_usd, filled_usd: o.filled_usd, next_slice_after: o.not_before }
            : {}),
        })),
      ),
    );
  }
  return parts.join("\n");
}

/**
 * The shared post-triage path: investigate -> spend accounting -> decision
 * snapshot + outcome-scoring enqueue -> audit -> (live) execution. Used by the
 * news worker, the position watcher, and the daily review — one code path so
 * every decision, whatever triggered it, is audited and scored identically.
 */
export async function investigateAndAct(
  item: NewsItem,
  hypotheses: string[],
  web: WebSearch | null,
): Promise<TradeDecision[]> {
  const session = web ? web.session(item.headline) : null;
  const search = session ? session.search : null;
  const bookContext = await buildBookContext().catch((e) => {
    console.error("[pipeline] book context failed:", e);
    return undefined;
  });
  const inv = await investigate(item, hypotheses, search, item.id, bookContext);
  // Grounded searches are Bedrock spend too. Folded in here so the budget
  // breaker, the log line and the decision row all see the whole cost of the run.
  inv.costUsd += session?.costUsd ?? 0;
  await addSpend(inv.costUsd);

  const decidedAt = new Date().toISOString();
  const n = inv.decisions.length;
  console.log(
    `[pipeline] ${item.id}: ${n} action(s) (${inv.numTurns} turns, $${inv.costUsd.toFixed(2)})`,
  );

  for (let i = 0; i < n; i++) {
    const d = inv.decisions[i];
    // Per-action id: order idempotency + independent outcome scoring.
    const actionId = n === 1 ? item.id : `${item.id}#${i + 1}`;

    const scoreSymbol = d.symbol ?? d.watch_symbol;
    const scoreKind = d.kind ?? d.watch_kind ?? "auto";
    if (scoreSymbol) {
      const res = await resolve(scoreSymbol, scoreKind as any);
      await enqueueScore({
        news_id: actionId,
        symbol: scoreSymbol,
        kind: res.ok ? res.quote.kind : scoreKind,
        action: d.action,
        confidence: d.confidence,
        decided_at: decidedAt,
        dry_run: config.dryRun,
        degraded: inv.degraded,
        price0:
          res.ok && res.meta.ageSecs <= 30 * 60 ? entryPrice(res.quote, d.action) : null,
      }).catch((e) => console.error("[pipeline] enqueueScore failed:", e));
    }

    // Cross-episode memory: each action's rationale becomes/updates the
    // standing thesis for every symbol it references.
    for (const sym of new Set(
      [d.symbol, d.watch_symbol].filter((s): s is string => !!s),
    )) {
      await recordThesis(sym, {
        at: decidedAt,
        action: d.action,
        confidence: d.confidence,
        trigger: item.source_family,
        rationale: d.rationale,
      }).catch((e) => console.error("[pipeline] recordThesis failed:", e));
    }

    console.log(
      `[pipeline]   ${i + 1}/${n}: ${d.action}` +
        (d.symbol ? ` ${d.symbol}` : "") +
        (Number.isFinite(d.notional_usd) ? ` $${d.notional_usd}` : "") +
        ` (conf ${d.confidence})`,
    );

    if (d.action === "hold" || config.dryRun) continue;

    // A fresh decision on a symbol supersedes any order parked for it.
    await cancelPending(d.symbol!).catch(() => {});
    const outcome = await executeDecision(
      d as TradeDecision & { action: "buy" | "sell" },
      actionId,
      resolve,
      item.id,
    );
    await putAudit(item.id, "v2-execution", { action_id: actionId, ...outcome });
    if (outcome.status === "filled") {
      const f = outcome.fill;
      console.log(
        `[pipeline]   FILLED ${f.side} ${f.qty} ${f.symbol} @ ${f.fillPrice} ` +
          `(${f.slippageBps.toFixed(1)} bps slip, ${f.quoteSource})` +
          (outcome.liquidityCapped
            ? ` LIQUIDITY-CAPPED: requested $${outcome.liquidityCapped.requested}, book $${outcome.liquidityCapped.bookUsd}`
            : ""),
      );
      // A capped fill that REDUCES a position leaves the rest working the book
      // (one slice per config.pendingSliceMinutes) instead of dropping it, so a
      // decided exit completes over hours rather than 25% of it once. Opening
      // fills are not sliced: sizing an entry to the book is the agent's job.
      if (outcome.liquidityCapped && isReduction(f.side, outcome.positionBefore)) {
        const base: PendingOrder = {
          symbol: f.symbol,
          kind: d.kind,
          side: f.side,
          notional_usd: outcome.liquidityCapped.requested,
          limit_price: d.limit_price,
          confidence: d.confidence,
          news_id: item.id,
          action_id: actionId,
          created_at: decidedAt,
          expires_at: new Date(Date.now() + config.pendingExpiryHours * 3_600_000).toISOString(),
          parked_reason: "liquidity_capped",
          rationale: d.rationale.slice(0, 600),
        };
        const rest = remainderAfter(base, f.notionalUsd, positionAfterFill(outcome.positionBefore, f.side, f.qty));
        if (rest) {
          await savePending(rest);
          await putAudit(item.id, "v2-order-parked", {
            order: rest,
            outcome: {
              status: "partial",
              reason: "liquidity_capped",
              filled_usd: f.notionalUsd,
              requested_usd: rest.requested_usd,
              book_usd: outcome.liquidityCapped.bookUsd,
            },
          });
          console.log(
            `[pipeline]   WORKING remainder ${rest.side} ${rest.symbol} $${rest.notional_usd} ` +
              `(liquidity_capped; next slice after ${rest.not_before}, expires ${rest.expires_at})`,
          );
        }
      }
    } else if (PARKABLE_REASONS.has(outcome.reason)) {
      const order = {
        symbol: d.symbol!,
        kind: d.kind,
        side: d.action as "buy" | "sell",
        notional_usd: d.notional_usd!,
        limit_price: d.limit_price,
        confidence: d.confidence,
        news_id: item.id,
        action_id: actionId,
        created_at: decidedAt,
        expires_at: new Date(
          Date.now() + config.pendingExpiryHours * 3_600_000,
        ).toISOString(),
        parked_reason: outcome.reason,
        rationale: d.rationale.slice(0, 600),
      };
      await savePending(order);
      await putAudit(item.id, "v2-order-parked", { order, outcome });
      console.log(
        `[pipeline]   PARKED ${order.side} ${order.symbol} $${order.notional_usd} ` +
          `(${outcome.reason}; retries until ${order.expires_at})`,
      );
    } else {
      console.log(`[pipeline]   dropped: ${outcome.reason} — ${outcome.detail}`);
    }
  }

  await putAudit(item.id, "v2-decision", {
    decisions: inv.decisions,
    cost_usd: inv.costUsd,
    // The tokens behind cost_usd as the SDK reported them (cost_usd also carries
    // the grounded-search spend), and whether they were priced at the fallback
    // rate because the model matched no pricing row (pricing.ts).
    usage: inv.usage ?? null,
    priced_with_fallback: inv.pricedWithFallback ?? false,
    num_turns: inv.numTurns,
    degraded: inv.degraded,
    errored: inv.errored,
    // Only present when the Bedrock guardrail blocked a call in this run (guardrail.ts).
    ...(inv.guardrailIntervened ? { guardrail_intervened: true } : {}),
    // Submitted before the run failed, so not executed (run-decisions.ts).
    ...(inv.withheld ? { withheld_decisions: inv.withheld } : {}),
    // Which model decided — the letter must not pin one model's habits on another
    // (everything before 2026-09-01 18:39 EDT ran on Fable 5, not 5.1).
    model: config.masterModel,
    // Watch alerts and reviews never pass through triage, so this is the only
    // place the letter can learn what the investigation was about.
    headline: item.headline,
    transcript: inv.transcriptUri,
    summary: inv.finalText.slice(0, 4000),
    dry_run: config.dryRun,
    trigger: item.source_family,
  });
  // Triage's anti-repeat rule needs every adjudication, not just the news ones.
  // A watch alert or the daily review re-underwrites a position minutes before
  // the next advisory arrives; recording only the news path left triage blind to
  // a decision made seconds earlier and it re-scored the same story as fresh.
  recentActivity.recordInvestigation(item.headline, inv.decisions);
  return inv.decisions;
}
