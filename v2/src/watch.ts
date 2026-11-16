// SPDX-License-Identifier: MIT-0
import { PutCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { yahooBars } from "./quotes/yahoo.js";
import { alertThresholdPct, dailySigmaPct } from "./guards.js";
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
import { getTheses, getThesis } from "./thesis.js";
import { recordResolution } from "./tape.js";
import type { NewsItem, Quote } from "./types.js";
import { bookUtilization } from "./mandate.js";
import { isDust } from "./dust.js";

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
  /** The instrument's 20-day daily σ (%), when known: scales the threshold (V2_WATCH_VOL_SIGMA). */
  dailySigmaPct?: number | null;
}): { trigger: boolean; movePct: number; thin?: string } {
  const movePct = (opts.price / opts.refPrice - 1) * 100;
  const threshold =
    opts.kind === "prediction"
      ? config.watchMovePredictionPct
      : alertThresholdPct(config.watchMovePct, opts.dailySigmaPct ?? null, config.watchVolSigma);
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

/** v6: exit deadlines already put to the agent (symbol|exit_by), so each plan's time stop fires once. */
const timeStopped = new Set<string>();

/**
 * Claim a plan's time stop in the table, so it fires once per exit_by across restarts too:
 * the in-memory set alone re-fired every past deadline on each restart (v6 Iran ceasefire,
 * 2026-10-25: exit_by 10-23 03:00, re-investigated at the next deploy). False = already fired.
 * Rows expire with the table's TTL after 30 days.
 */
async function claimTimeStop(symbol: string, exitBy: string): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: config.table,
        Item: { pk: `TIMESTOP#${symbol}`, sk: exitBy, fired_at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 30 * 86_400 },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** v6: the position's stated exit deadline has passed — re-decide against the plan, not the tape. */
function timeStopItem(p: Position, plan: { exit_by: string; exit_target?: number; exit_stop?: number; fair_probability?: number; rationale: string }, price: number, quote: Quote): NewsItem {
  const now = new Date().toISOString();
  const id = `timestop-${p.symbol}-${Date.now()}`;
  return {
    id,
    source_family: "position-watch",
    source_id: id,
    published_at: now,
    ingested_at: now,
    headline: `Exit deadline reached: ${p.symbol} (plan said re-decide by ${plan.exit_by}; now ${price} bid)`,
    summary: JSON.stringify({
      position: { symbol: p.symbol, kind: p.kind, qty: p.qty, avg_cost: p.avg_cost },
      book: { bid: quote.bid ?? null, ask: quote.ask ?? null, liquidity_usd: quote.liquidityUsd ?? null },
      plan: { exit_target: plan.exit_target ?? null, exit_stop: plan.exit_stop ?? null, exit_by: plan.exit_by, fair_probability: plan.fair_probability ?? null },
      thesis: plan.rationale.slice(0, 600),
      note:
        "Internal time stop, not news. The move this position was opened for should have happened by now. " +
        "Sell unless the thesis has a fresh, specific reason to live — then set a new exit plan.",
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
  allPositions: Position[],
  web: WebSearch | null,
): Promise<void> {
  // The review is of real positions; dust lines (dust.ts) carry no thesis to re-check.
  const positions = allPositions.filter((p) => !isDust(p));
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
        `why its expected move over the next ${config.fastDesk ? "24 hours" : "1–7 days"} does not clear the spread. Position ` +
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

/**
 * 20-day daily σ for the alert threshold, from Yahoo daily bars; cached per symbol per UTC day.
 * Equities and futures only (their symbols are Yahoo symbols); anything else, or a fetch that
 * fails, returns null and keeps the fixed threshold.
 */
const sigmaCache = new Map<string, { day: string; sigma: number | null }>();
async function sigmaFor(symbol: string, kind: string): Promise<number | null> {
  if (kind !== "equity" && kind !== "futures") return null;
  const day = new Date().toISOString().slice(0, 10);
  const hit = sigmaCache.get(symbol);
  if (hit && hit.day === day) return hit.sigma;
  const bars = await yahooBars(symbol, { interval: "1d", startMs: Date.now() - 45 * 86_400_000, endMs: Date.now() }).catch(() => []);
  const sigma = dailySigmaPct(bars.slice(-21).map((b) => b.close));
  sigmaCache.set(symbol, { day, sigma });
  return sigma;
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
      // Dust (a rounding remainder worth < config.dustUsd) is not a position: no
      // re-quote, no alert, no investigation. Settlement above still runs for it.
      if (isDust(p)) continue;
      const res = await resolve(p.symbol, p.kind as any);
      // Every re-quote goes to the tape (fire-and-forget; the tape never throws).
      recordResolution(res, { origin: "watch" }).catch(() => {});
      if (!res.ok || res.meta.ageSecs > 30 * 60) continue;
      // Liquidation value (bid), the same basis the ledger marks at — never the
      // mid. On the $40-deep Texas book the mid flashed +232% and -48% "moves"
      // nobody could transact against, and each one burned an investigation.
      const price = liquidationPrice(res.quote, p.qty);
      // v6: the exit plan's deadline is a trigger of its own.
      if (config.fastDesk) {
        const t = await getThesis(p.symbol).catch(() => null);
        const by = t?.latest.exit_by;
        if (by && Date.parse(by) <= Date.now() && !timeStopped.has(`${p.symbol}|${by}`)) {
          timeStopped.add(`${p.symbol}|${by}`);
          const budget = await checkBudget({ priority: true });
          // A table error fails open (fire it): a missed exit costs more than a repeated one.
          if (budget.allowed && (await claimTimeStop(p.symbol, by).catch(() => true))) {
            console.log(`[watch] TIME STOP ${p.symbol}: exit_by ${by} passed — investigating`);
            await investigateAndAct(timeStopItem(p, { ...t!.latest, exit_by: by }, price, res.quote), ["Exit unless the thesis has a fresh reason to live"], web);
            await markWatched(p.symbol, price);
            continue;
          }
        }
      }
      // v6: contract alerts move on the mid, so a widening book is not a "loss" that triggers an
      // investigation (v5 added to a position on alerts it called "from the spread, not from news").
      const triggerPrice =
        config.fastDesk && p.kind === "prediction" && res.quote.bid !== undefined && res.quote.ask !== undefined
          ? (res.quote.bid + res.quote.ask) / 2
          : price;
      const { trigger, movePct, thin } = shouldTrigger({
        price: triggerPrice,
        refPrice: p.last_watch_price ?? p.avg_cost,
        kind: p.kind ?? "equity",
        lastWatchAtMs: p.last_watch_at ? Date.parse(p.last_watch_at) : null,
        nowMs: Date.now(),
        quote: res.quote,
        dailySigmaPct: config.watchVolSigma > 0 && p.kind !== "prediction" ? await sigmaFor(p.symbol, p.kind ?? "equity") : null,
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
      await markWatched(p.symbol, triggerPrice);
    } catch (e) {
      console.error(`[watch] failed on ${p.symbol}:`, e);
    }
  }

  await dailyReview(positions, web).catch((e) =>
    console.error("[watch] daily review failed:", e),
  );
}
