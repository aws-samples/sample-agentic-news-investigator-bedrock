// SPDX-License-Identifier: MIT-0
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb, listPositions, getPortfolio, recordFill, type Position } from "./ledger.js";
import { resolve } from "./quotes/resolver.js";
import { checkResolution } from "./quotes/prediction.js";
import { investigateAndAct } from "./pipeline.js";
import { retryPending } from "./pending.js";
import { liquidationPrice } from "./exec.js";
import { putAudit } from "./audit.js";
import { checkBudget, dayKey } from "./budget.js";
import type { WebSearch } from "./websearch.js";
import { getTheses } from "./thesis.js";
import { recordResolution } from "./tape.js";
import type { NewsItem, Quote } from "./types.js";
import { bookUtilization } from "./mandate.js";

/**
 * Event-driven selling: price moves ARE events. Every few minutes the watcher
 * re-quotes each open position; a fresh +-N% leg since the last reference
 * price (entry, or the price at the last alert) synthesizes a position-alert
 * event and runs a normal investigation whose live options are hold/sell/add.
 * No mechanical stops — the agent stays the only authority; the watcher only
 * guarantees the question gets asked while the move is happening.
 * Also here: prediction-market settlement (resolved contracts -> cash at $1/$0,
 * pure bookkeeping) and the once-a-day whole-book review (the safety net).
 */

/**
 * A book too thin to transact against makes the move meaningless: the agent
 * cannot sell into $16 of depth, and a bid tick on such a book is one order
 * disappearing, not a repricing. Returns the reason when the book fails.
 */
export function thinBook(q: { price: number; bid?: number; ask?: number; liquidityUsd?: number }): string | null {
  if (q.liquidityUsd !== undefined && q.liquidityUsd < config.watchMinDepthUsd) {
    return `depth $${q.liquidityUsd.toFixed(0)} < $${config.watchMinDepthUsd}`;
  }
  if (q.bid !== undefined && q.ask !== undefined && q.bid > 0 && q.ask > 0) {
    const mid = (q.bid + q.ask) / 2;
    const frac = (q.ask - q.bid) / mid;
    if (frac > config.watchMaxSpreadFrac) return `spread ${(frac * 100).toFixed(0)}% of mid > ${Math.round(config.watchMaxSpreadFrac * 100)}%`;
  }
  return null;
}

export function shouldTrigger(opts: {
  price: number;
  refPrice: number;
  kind: string;
  lastWatchAtMs: number | null;
  nowMs: number;
  /** The live book; when given, a qualifying move on a thin book is reported as `thin` instead of triggering. */
  quote?: { price: number; bid?: number; ask?: number; liquidityUsd?: number };
}): { trigger: boolean; movePct: number; thin?: string } {
  const movePct = (opts.price / opts.refPrice - 1) * 100;
  const threshold =
    opts.kind === "prediction" ? config.watchMovePredictionPct : config.watchMovePct;
  const cooledDown =
    opts.lastWatchAtMs === null ||
    opts.nowMs - opts.lastWatchAtMs >= config.watchCooldownHours * 3_600_000;
  const crosses = Math.abs(movePct) >= threshold && cooledDown;
  if (!crosses) return { trigger: false, movePct };
  const thin = opts.quote ? thinBook(opts.quote) : null;
  if (thin) return { trigger: false, movePct, thin };
  return { trigger: true, movePct };
}

async function markWatched(symbol: string, price: number): Promise<void> {
  await ddb
    .send(
      new UpdateCommand({
        TableName: config.table,
        Key: { pk: `POSITION#${symbol}`, sk: "-" },
        UpdateExpression: "SET last_watch_price = :p, last_watch_at = :t",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":p": price, ":t": new Date().toISOString() },
      }),
    )
    .catch(() => {}); // position may have been sold during the investigation
}

function alertId(symbol: string): string {
  return `watch-${symbol.replace(/[^A-Za-z0-9:_-]/g, "")}-${Date.now()}`;
}

const lastCoverageAudit = new Map<string, number>();
/**
 * A suppressed alert or skipped review is the book moving while the agent is
 * not asked — the daily letter must be able to see that, so it goes to the
 * audit trail, not just the log. The watcher re-refuses every pass (5 min)
 * until the budget resets, so allow one row per key per hour.
 */
function coverageAuditDue(key: string): boolean {
  const last = lastCoverageAudit.get(key) ?? 0;
  if (Date.now() - last < 3_600_000) return false;
  lastCoverageAudit.set(key, Date.now());
  return true;
}

async function auditSuppressed(
  symbol: string,
  movePct: number,
  price: number,
  reason: string,
  kind: "budget" | "thin-book" = "budget",
): Promise<boolean> {
  if (!coverageAuditDue(`alert:${kind}:${symbol}`)) return false;
  await putAudit(alertId(symbol), "v2-watch-suppressed", {
    symbol,
    move_pct: Number(movePct.toFixed(1)),
    price,
    reason,
    kind,
  }).catch((e) => console.error("[watch] could not audit suppressed alert:", e));
  return true;
}

function alertItem(
  p: Position & { last_watch_price?: number; last_watch_at?: string },
  price: number,
  movePct: number,
  unrealized: number,
  quote: Quote,
): NewsItem {
  const now = new Date().toISOString();
  const id = alertId(p.symbol);
  const dir = movePct >= 0 ? "+" : "";
  return {
    id,
    source_family: "position-watch",
    source_id: id,
    published_at: now,
    ingested_at: now,
    headline:
      `Position alert: ${p.qty < 0 ? "SHORT " : ""}${p.symbol} moved ${dir}${movePct.toFixed(1)}% ` +
      `(now ${price} ${p.qty < 0 ? "ask" : "bid"}) since last reference — re-evaluate hold vs ${p.qty < 0 ? "cover" : "sell"}`,
    summary: JSON.stringify({
      position: { symbol: p.symbol, kind: p.kind, qty: p.qty, side: p.qty < 0 ? "short" : "long", avg_cost: p.avg_cost },
      current_price: price,
      price_basis: p.qty < 0 ? "ask (what covering the short costs)" : "bid (liquidation value). The mid of a thin book is not a price you can get.",
      book: {
        bid: quote.bid ?? null,
        ask: quote.ask ?? null,
        liquidity_usd: quote.liquidityUsd ?? null,
      },
      unrealized_pnl_usd: Number(unrealized.toFixed(2)),
      note:
        "This is an internal price-move alert, not news. Decide: close some or all (sell a long / " +
        "buy to cover a short), hold, or add. Consider whether the original thesis is intact and " +
        "whether the move has already run.",
    }),
    url: "",
    tickers_hint: [p.symbol],
    asset_class_hint: null,
  };
}

async function settle(p: Position, payout: number): Promise<void> {
  const decisionId = `settle-${p.symbol}-${dayKey()}`;
  const realizedPnl = (payout - p.avg_cost) * p.qty;
  await recordFill(
    {
      decisionId,
      newsId: decisionId,
      symbol: p.symbol,
      kind: "prediction",
      side: "sell",
      qty: p.qty,
      quotePrice: payout,
      fillPrice: payout,
      slippageBps: 0,
      notionalUsd: p.qty * payout,
      quoteSource: "settlement",
      realizedPnl,
      filledAt: new Date().toISOString(),
    },
    { newQty: 0, newAvgCost: p.avg_cost, expectedQty: p.qty },
  );
  await putAudit(decisionId, "v2-settlement", {
    symbol: p.symbol,
    qty: p.qty,
    payout,
    realized_pnl: realizedPnl,
  });
  console.log(
    `[watch] SETTLED ${p.symbol}: ${p.qty} contracts @ $${payout} ` +
      `(realized ${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)})`,
  );
}

async function dailyReview(
  positions: Position[],
  web: WebSearch | null,
): Promise<void> {
  const today = dayKey();
  // An empty book is reviewed too: under the mandate it is the case that most
  // needs the slow look (the watchlist is where its first positions come from).
  if (new Date().getUTCHours() < config.reviewHourUtc) return;
  const state = await ddb.send(
    new GetCommand({ TableName: config.table, Key: { pk: "STATE", sk: "DAILY_REVIEW" } }),
  );
  if (state.Item?.day === today) return;
  const id = `review-${today}`;
  // A review one minute after every position was re-underwritten by an alert is
  // a second bill for the same look. Defer while the whole book is fresh, but
  // never past the grace window — the slow look must still happen every day.
  const hoursPastReview = (Date.now() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), config.reviewHourUtc)) / 3_600_000;
  // Freshness excuses a review of what is held, never a review of what is not:
  // a book under the mandate's floor has deployment work whatever the alerts did.
  const portfolio = await getPortfolio();
  const util = bookUtilization({
    cash_usd: portfolio?.cash ?? null,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      avg_cost: p.avg_cost,
      last_seen_price: (p as { last_watch_price?: number }).last_watch_price ?? null,
    })),
  });
  const underDeployed = util.deployedPct !== null && util.deployedPct < config.mandate.minDeployedPct;
  if (hoursPastReview < config.reviewGraceHours && !underDeployed) {
    const theses = await getTheses(positions.map((p) => p.symbol)).catch(() => []);
    const freshMs = config.reviewSkipIfFreshMin * 60_000;
    const allFresh =
      theses.length === positions.length &&
      theses.every((t) => Date.now() - Date.parse(t.latest.at) < freshMs);
    if (allFresh) {
      if (coverageAuditDue("review-defer")) {
        console.log(`[watch] deferring daily review: all ${positions.length} positions re-underwritten within ${config.reviewSkipIfFreshMin} min`);
      }
      return;
    }
  }
  // Budget before the claim: a review refused for budget must stay unclaimed so
  // it can still run later in the day, and the refusal must reach the letter.
  const budget = await checkBudget({ priority: true });
  if (!budget.allowed) {
    console.warn(`[watch] skipping daily review: ${budget.reason}`);
    if (coverageAuditDue("review")) {
      await putAudit(id, "v2-skipped", {
        reason: budget.reason,
        trigger: "daily-review",
        headline: `Daily portfolio review: ${positions.length} open positions`,
      }).catch(() => {});
    }
    return;
  }
  // Claim so a crash mid-review doesn't double-spend tomorrow's slot.
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: { pk: "STATE", sk: "DAILY_REVIEW", day: today },
    }),
  );

  const book: any[] = [];
  for (const p of positions) {
    const res = await resolve(p.symbol, p.kind as any);
    recordResolution(res, { origin: "watch" }).catch(() => {});
    book.push({
      symbol: p.symbol,
      kind: p.kind,
      qty: p.qty,
      avg_cost: p.avg_cost,
      side: p.qty < 0 ? "short" : "long",
      price: res.ok ? liquidationPrice(res.quote, p.qty) : null,
      unrealized_usd: res.ok ? Number(((liquidationPrice(res.quote, p.qty) - p.avg_cost) * p.qty).toFixed(2)) : null,
    });
  }
  const now = new Date().toISOString();
  const item: NewsItem = {
    id,
    source_family: "daily-review",
    source_id: id,
    published_at: now,
    ingested_at: now,
    headline: `Daily portfolio review: ${positions.length} open positions — take whatever actions the book needs`,
    summary: JSON.stringify({
      cash: portfolio?.cash,
      positions: book,
      deployed_pct: util.deployedPct === null ? null : Math.round(util.deployedPct * 100),
      mandate_floor_pct: Math.round(config.mandate.minDeployedPct * 100),
      note:
        "Internal review, not news. Two jobs. (1) Re-underwrite each held position's thesis " +
        "against current prices — exit what is broken, trim or add where conviction changed. " +
        "(2) Apply the deployment mandate in the book context: if the book is under its floor, " +
        "this review is where new positions come from — go through the watchlist and open a " +
        "starter or full position in every candidate that still has a direction, one " +
        "submit_decision per entry, sized by the ladder; for each candidate you pass on, say " +
        "why its expected move over the next 1–7 days does not clear the spread. Position " +
        "alerts cover intraday moves; this is the slower look.",
    }),
    url: "",
    tickers_hint: positions.map((p) => p.symbol),
    asset_class_hint: null,
  };
  console.log(`[watch] running daily review of ${positions.length} positions`);
  await investigateAndAct(
    item,
    [
      "Review each thesis against current prices",
      "Deploy: if the book is under the mandate's floor, open positions from the watchlist or state per candidate why not",
    ],
    web,
  );
}

export async function watchPass(web: WebSearch | null): Promise<void> {
  // Parked (at-open / limit) orders first: fill, expire, or keep waiting.
  await retryPending().catch((e) => console.error("[watch] retryPending failed:", e));

  const positions = (await listPositions()) as (Position & {
    last_watch_price?: number;
    last_watch_at?: string;
  })[];

  for (const p of positions) {
    try {
      if (p.kind === "prediction") {
        const status = await checkResolution(p.symbol);
        if (status.resolved && status.payout !== undefined) {
          await settle(p, status.payout);
          continue;
        }
      }
      const res = await resolve(p.symbol, p.kind as any);
      // Every re-quote goes to the tape (fire-and-forget; the tape never throws).
      recordResolution(res, { origin: "watch" }).catch(() => {});
      if (!res.ok || res.meta.ageSecs > 30 * 60) continue;
      // Liquidation value (bid), the same basis the ledger marks at — never the
      // mid. On the $40-deep Texas book the mid flashed +232% and -48% "moves"
      // nobody could transact against, and each one burned an investigation.
      const price = liquidationPrice(res.quote, p.qty);
      const { trigger, movePct, thin } = shouldTrigger({
        price,
        refPrice: p.last_watch_price ?? p.avg_cost,
        kind: p.kind ?? "equity",
        lastWatchAtMs: p.last_watch_at ? Date.parse(p.last_watch_at) : null,
        nowMs: Date.now(),
        quote: res.quote,
      });
      if (thin) {
        // The letter must still see that the book moved while nobody was asked;
        // one audit row per symbol per hour, and log only when the row is written.
        if (await auditSuppressed(p.symbol, movePct, price, `thin book: ${thin}`, "thin-book")) {
          console.log(`[watch] ${p.symbol}: ${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}% on a thin book (${thin}) — not an event`);
        }
        continue;
      }
      if (!trigger) continue;
      const budget = await checkBudget({ priority: true });
      if (!budget.allowed) {
        console.warn(`[watch] alert on ${p.symbol} suppressed: ${budget.reason}`);
        await auditSuppressed(p.symbol, movePct, price, budget.reason ?? "budget");
        continue;
      }
      const unrealized = (price - p.avg_cost) * p.qty;
      console.log(
        `[watch] ALERT ${p.symbol}: ${movePct >= 0 ? "+" : ""}${movePct.toFixed(1)}% leg — investigating`,
      );
      await investigateAndAct(
        alertItem(p, price, movePct, unrealized, res.quote),
        ["Sell if the thesis is broken or the move has run; hold if it's noise; add only with fresh conviction"],
        web,
      );
      await markWatched(p.symbol, price);
    } catch (e) {
      console.error(`[watch] failed on ${p.symbol}:`, e);
    }
  }

  await dailyReview(positions, web).catch((e) =>
    console.error("[watch] daily review failed:", e),
  );
}
