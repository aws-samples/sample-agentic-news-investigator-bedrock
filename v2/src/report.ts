// SPDX-License-Identifier: MIT-0
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { config, arms } from "./config.js";
import { tableFor, type Arm } from "./arms.js";
import { ddb, listPositions, getPortfolioOf, type Position } from "./ledger.js";
import { resolve, inferKind } from "./quotes/resolver.js";
import { liquidationPrice } from "./exec.js";
import { dayKey } from "./budget.js";
import { listScoreItems, HORIZONS, type HorizonKey, type ScoreItem } from "./score.js";
import { gatherEvents } from "./daily-report.js";
import { worldStats } from "./world.js";

/**
 * Daily A/B report across every arm in arms.json: the risk-gated pipeline arm
 * (the control) and each agent arm (the unconstrained investigator, with or
 * without the world model). Marks every book to market through the v2 resolver
 * and prints them side by side, then outcome scores and the world-model
 * measurements for the agent arms.
 * Run: npm run report
 */

/** The focus arm reads its configured table (V2_TABLE may override); every other arm's comes from the registry. */
function tableOf(arm: Arm): string {
  return tableFor(arm, arms, { key: config.arm, table: config.table });
}

/** Section title: what kind of arm this is, not only its label. */
function describe(arm: Arm): string {
  if (arm.kind === "pipeline") return `${arm.key} control (risk-gated pipeline)`;
  return arm.worldModel ? `${arm.key} investigator + world model` : `${arm.key} investigator (Agent SDK, no gate)`;
}

async function markToMarket(positions: Position[]): Promise<{ value: number; lines: string[] }> {
  let value = 0;
  const lines: string[] = [];
  for (const p of positions) {
    const kind = (p.kind as any) ?? inferKind(p.symbol);
    const res = await resolve(p.symbol, kind);
    if (res.ok) {
      // Liquidation value (bid) — mid-price marks on thin books are fiction.
      const liq = liquidationPrice(res.quote, p.qty);
      const mv = p.qty * liq;
      const pnl = (liq - p.avg_cost) * p.qty;
      value += mv;
      const spreadNote =
        res.quote.bid !== undefined && res.quote.ask !== undefined && res.quote.ask - res.quote.bid > 0.1 * res.quote.price
          ? ` [WIDE BOOK ${res.quote.bid}/${res.quote.ask}, depth $${res.quote.liquidityUsd ?? "?"}]`
          : "";
      lines.push(
        `  ${p.symbol.padEnd(28)} qty ${p.qty} @ bid ${liq}${res.quote.resolved ? " (RESOLVED)" : ""} ` +
          `mv $${mv.toFixed(2)} unrealized ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}${spreadNote}`,
      );
    } else {
      const mv = p.qty * p.avg_cost;
      value += mv;
      lines.push(`  ${p.symbol.padEnd(28)} qty ${p.qty} UNQUOTABLE (${res.reason}) — at cost $${mv.toFixed(2)}`);
    }
  }
  return { value, lines };
}

async function spendToday(): Promise<{ cost: number; investigations: number }> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "pk = :p AND sk = :s",
      ExpressionAttributeValues: { ":p": "SPEND", ":s": `DAY#${dayKey()}` },
    }),
  );
  const item = r.Items?.[0];
  return { cost: Number(item?.cost_usd ?? 0), investigations: Number(item?.investigations ?? 0) };
}

async function book(name: string, table: string): Promise<void> {
  const portfolio = await getPortfolioOf(table);
  if (!portfolio) {
    console.log(`\n== ${name} (${table}) == not seeded`);
    return;
  }
  const positions = await listPositions(table);
  const { value, lines } = await markToMarket(positions);
  const equity = portfolio.cash + value;
  console.log(`\n== ${name} (${table}) ==`);
  console.log(`  cash $${portfolio.cash.toFixed(2)}  positions $${value.toFixed(2)}  EQUITY $${equity.toFixed(2)}`);
  console.log(`  realized today ${portfolio.realized_pnl_today >= 0 ? "+" : ""}$${Number(portfolio.realized_pnl_today).toFixed(2)}  open positions ${positions.length}`);
  for (const l of lines) console.log(l);
}

const RET_ATTR: Record<HorizonKey, "ret_1h" | "ret_1d" | "ret_7d"> = {
  "1h": "ret_1h",
  "1d": "ret_1d",
  "7d": "ret_7d",
};

function horizonLine(items: ScoreItem[], h: HorizonKey): string {
  const vals = items
    .map((i) => i[RET_ATTR[h]])
    .filter((v): v is number => typeof v === "number");
  if (vals.length === 0) return `  ${h}: no scores yet`;
  const meanPct = (vals.reduce((a, b) => a + b, 0) / vals.length) * 100;
  const wins = vals.filter((v) => v > 0).length;
  return `  ${h}: n=${vals.length} mean ${meanPct >= 0 ? "+" : ""}${meanPct.toFixed(2)}% win-rate ${((wins / vals.length) * 100).toFixed(0)}%`;
}

/** The reward readout: decisions scored against what prices actually did. */
async function outcomes(label: string, table: string): Promise<void> {
  const items = [...(await listScoreItems("P#", table)), ...(await listScoreItems("D#", table))];
  console.log(`\n== ${label} decision outcomes (${items.length} scored/pending) ==`);
  if (items.length === 0) return;
  const trades = items.filter((i) => i.action !== "hold");
  const holds = items.filter((i) => i.action === "hold");
  const degraded = items.filter((i) => i.degraded).length;
  console.log(`trades ${trades.length} (signed return; + = direction was right):`);
  for (const h of Object.keys(HORIZONS) as HorizonKey[]) console.log(horizonLine(trades, h));
  console.log(`holds with watch_symbol ${holds.length} (counterfactual buy return; small/negative = good hold):`);
  for (const h of Object.keys(HORIZONS) as HorizonKey[]) console.log(horizonLine(holds, h));
  if (degraded > 0) console.log(`degraded (no web search) runs among scored: ${degraded}`);
}

/**
 * The three things the world-model experiment is measured on, per agent arm,
 * over the last 24h: does "touches a held position" stop firing on unrelated
 * corporate filings (measured on every agent arm, so the arms can be compared);
 * what the gate accepted and refused; and whether the curiosity loop ever asks
 * a question the news feed would not have (and trades on it). The gate and
 * world-model lines only apply to an arm that runs the world model.
 */
async function measurements(label: string, table: string, worldModel: boolean): Promise<void> {
  const since = Date.now() - 24 * 3_600_000;
  const { events } = await gatherEvents(since, table).catch(() => ({ events: [], rowMs: [] }));
  const triaged = events.filter((e) => e.materiality !== undefined);
  const corporate = triaged.filter((e) => e.eventType === "corporate");
  const corpTouch = corporate.filter((e) => e.touches);
  const corpInv = corporate.filter((e) => e.decisions);
  const investigated = events.filter((e) => e.decisions);
  const curiosity = investigated.filter((e) => e.curiosity || e.trigger === "curiosity");
  const proposals = worldModel ? investigated.filter((e) => e.proposals) : [];
  const acc = proposals.reduce((n, e) => n + e.proposals!.accepted, 0);
  const rej = proposals.reduce((n, e) => n + e.proposals!.rejected, 0);
  console.log(`\n== ${label} measurements, last 24h ==`);
  console.log(`  triaged ${triaged.length}; corporate ${corporate.length}, flagged touching a position ${corpTouch.length} (${corporate.length ? ((corpTouch.length / corporate.length) * 100).toFixed(0) : 0}%), investigated ${corpInv.length}`);
  console.log(`  investigations ${investigated.length}; curiosity-driven ${curiosity.length}, of which traded ${curiosity.filter((e) => e.executions.some((x: any) => x.status === "filled")).length}`);
  if (proposals.length > 0) {
    const checks: Record<string, number> = {};
    for (const e of proposals) for (const [k, v] of Object.entries(e.proposals!.checks)) checks[k] = (checks[k] ?? 0) + v;
    console.log(`  world-model proposals: ${acc} accepted, ${rej} rejected (${Object.entries(checks).map(([k, v]) => `${k} ${v}`).join(", ")})`);
    for (const e of proposals) for (const r of e.rejections ?? []) console.log(`    rejected — ${r}`);
    const ws = await worldStats(table).catch(() => null);
    if (ws) console.log(`  world model now: ${Object.entries(ws.nodes).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(", ")}; ${ws.edges} edges, ${ws.facts} facts`);
  }
}

async function main(): Promise<void> {
  console.log(`${config.prefix} A/B report — ${new Date().toISOString()}`);
  for (const a of arms.arms) await book(describe(a), tableOf(a));
  const agents = arms.arms.filter((a) => a.kind === "agent");
  for (const a of agents) await outcomes(a.key, tableOf(a));
  for (const a of agents) await measurements(a.key, tableOf(a), a.worldModel);
  const spend = await spendToday();
  // Note: the worker's dry-run mode lives in its own supervisor env, not ours.
  console.log(
    `\n${config.arm} spend today: $${spend.cost.toFixed(2)} across ${spend.investigations} investigations`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
