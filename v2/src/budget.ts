// SPDX-License-Identifier: MIT-0
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { config } from "./config.js";
import { ddb } from "./ledger.js";

/**
 * The one place v2 touches real money is LLM spend, so this is the only hard
 * breaker in the system: a daily USD ceiling (SSM-tunable) plus an
 * investigations/day cap, tracked in the v2 table under SPEND / DAY#<date>.
 */

const ssm = new SSMClient({ region: config.region });
const paramCache = new Map<string, { value: string; at: number }>();
const PARAM_TTL_MS = 60_000;

/**
 * Reads an SSM parameter (cached for PARAM_TTL_MS). Throws when it cannot be
 * read — a missing parameter, a denied read, an SSM outage — so each caller
 * decides how to fail, and every caller here fails closed: an unreadable kill
 * switch counts as ON and an unreadable budget allows nothing. Until
 * 2026-10-07 this returned "false" / "25", i.e. a broken read silently
 * turned the kill switch off and set a $25 ceiling the operator never chose.
 */
async function param(name: string): Promise<string> {
  const hit = paramCache.get(name);
  if (hit && Date.now() - hit.at < PARAM_TTL_MS) return hit.value;
  const r = await ssm.send(new GetParameterCommand({ Name: name }));
  const value = r.Parameter?.Value;
  if (value === undefined) throw new Error(`SSM parameter ${name} has no value`);
  paramCache.set(name, { value, at: Date.now() });
  return value;
}

/** Fails closed: an unreadable kill switch halts the arm. */
export async function killSwitchOn(): Promise<boolean> {
  try {
    return (await param(config.killSwitchParam)).trim() === "true";
  } catch (e) {
    console.error(`[budget] kill switch ${config.killSwitchParam} unreadable; treating it as ON:`, e);
    return true;
  }
}

/** The daily ceiling, or null when the parameter cannot be read or is not a number. */
async function readDailyBudget(): Promise<number | null> {
  try {
    const n = Number(await param(config.dailyBudgetParam));
    return Number.isFinite(n) ? n : null;
  } catch (e) {
    console.error(`[budget] daily budget ${config.dailyBudgetParam} unreadable:`, e);
    return null;
  }
}

export function dayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface SpendState {
  costUsd: number;
  investigations: number;
  allowed: boolean;
  reason?: string;
}

/** Pure budget rule, unit-tested. */
export function budgetAllows(opts: {
  costUsd: number;
  investigations: number;
  dailyBudget: number;
  priority: boolean;
}): { allowed: boolean; reason?: string } {
  const { costUsd, investigations, dailyBudget, priority } = opts;
  if (costUsd >= dailyBudget) {
    return { allowed: false, reason: `daily budget $${dailyBudget} spent` };
  }
  if (priority) return { allowed: true }; // position management: only the hard ceiling applies
  const newsCeiling = dailyBudget * (1 - config.budgetReserveFraction);
  if (costUsd >= newsCeiling) {
    return {
      allowed: false,
      reason: `news budget $${newsCeiling.toFixed(0)} spent (last $${(dailyBudget - newsCeiling).toFixed(0)} reserved for position management)`,
    };
  }
  if (investigations >= config.maxInvestigationsPerDay) {
    return {
      allowed: false,
      reason: `daily investigation cap (${config.maxInvestigationsPerDay}) reached`,
    };
  }
  return { allowed: true };
}

/**
 * `priority` = position management (watch alerts, daily review): may spend
 * the reserve news cannot touch. News spam must never blind the agent to a
 * position that is moving.
 */
/** The SSM-tunable daily ceiling, for display (the breaker itself lives in checkBudget). */
export async function dailyBudgetUsd(): Promise<number> {
  return (await readDailyBudget()) ?? 0;
}

export async function checkBudget(opts: { priority?: boolean } = {}): Promise<SpendState> {
  const key = dayKey();
  const r = await ddb.send(
    new GetCommand({ TableName: config.table, Key: { pk: "SPEND", sk: `DAY#${key}` } }),
  );
  const costUsd = Number(r.Item?.cost_usd ?? 0);
  const investigations = Number(r.Item?.investigations ?? 0);
  const dailyBudget = await readDailyBudget();
  if (dailyBudget === null) {
    return { costUsd, investigations, allowed: false, reason: `daily budget ${config.dailyBudgetParam} unreadable (fail closed)` };
  }
  const verdict = budgetAllows({
    costUsd,
    investigations,
    dailyBudget,
    priority: opts.priority ?? false,
  });
  return { costUsd, investigations, ...verdict };
}

/**
 * What a SPEND increment is. An investigation counts toward the per-day
 * investigation cap; triage spend (V2_METER_TRIAGE) is dollars only.
 */
export type SpendKind = "investigation" | "triage";

export async function addSpend(
  costUsd: number,
  opts: { scope?: string; kind?: SpendKind } = {},
): Promise<void> {
  const kind = opts.kind ?? "investigation";
  await ddb.send(
    new UpdateCommand({
      TableName: config.table,
      // A scope (e.g. "BENCH#<name>") keeps bench spend out of the live daily budget.
      Key: { pk: opts.scope ? `SPEND#${opts.scope}` : "SPEND", sk: `DAY#${dayKey()}` },
      // Triage spend goes into cost_usd (what the breaker reads) and is tallied
      // again as triage_cost_usd, so the investigation-only series the private
      // arms have always reported is recoverable by subtraction.
      UpdateExpression:
        kind === "triage"
          ? "ADD cost_usd :c, triage_cost_usd :c"
          : "ADD cost_usd :c, investigations :one",
      ExpressionAttributeValues: kind === "triage" ? { ":c": costUsd } : { ":c": costUsd, ":one": 1 },
    }),
  );
}

/** Whether Haiku triage and filing enrichment are metered into the daily spend (V2_METER_TRIAGE). */
export function shouldMeterTriage(): boolean {
  return config.meterTriage;
}

/** What one item's triage and (when it ran) enrichment cost, from the usage those calls reported. */
export function triageCostUsd(
  item: { enrichment?: { cost_usd?: number } | null },
  verdict: { cost_usd?: number } | null | undefined,
): number {
  return (verdict?.cost_usd ?? 0) + (item.enrichment?.cost_usd ?? 0);
}

/**
 * Meter one item's triage + enrichment spend into the daily breaker. A no-op
 * unless V2_METER_TRIAGE is on or `force` is set (the bench meters always,
 * under its own BENCH# scope). Never throws: metering must not stop the news
 * loop. Returns the dollars added.
 */
export async function meterTriage(
  item: { id?: string; enrichment?: { cost_usd?: number } | null },
  verdict: { cost_usd?: number } | null | undefined,
  opts: { scope?: string; force?: boolean } = {},
): Promise<number> {
  if (!opts.force && !shouldMeterTriage()) return 0;
  const usd = triageCostUsd(item, verdict);
  if (usd <= 0) return 0;
  try {
    await addSpend(usd, { scope: opts.scope, kind: "triage" });
  } catch (e) {
    console.error(`[budget] meterTriage failed for ${item.id ?? "?"}:`, e);
    return 0;
  }
  return usd;
}

/**
 * Cost of an Agent SDK result. Lives in pricing.ts now (per-model rates,
 * V2_MODEL_RATES_JSON, fallback flag); re-exported so existing imports work.
 */
export { estimateCostUsd } from "./pricing.js";
