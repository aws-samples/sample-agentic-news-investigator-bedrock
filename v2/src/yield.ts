// SPDX-License-Identifier: MIT-0
/**
 * Yield table: reads what the arm has spent and earned by news category and
 * stores the result as STATE / YIELD, which the worker consults at admission
 * when `V2_YIELD_TRIAGE=on` (see yield-data.ts for the method and the reasons).
 *
 *   npm run yield                    # print the table for this arm's table
 *   npm run yield -- --write         # also store it (STATE/YIELD)
 *   npm run yield -- --table fin-v3-trading --until 2026-09-12T00:00:00Z
 *
 * `--until` computes the table as of a past instant — decisions after it are
 * ignored and maturity is judged against it — which is how the replay bench
 * avoids lookahead. Reads only, plus the one STATE row on --write.
 */
import { pathToFileURL } from "node:url";
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";
import {
  aggregateYield,
  renderYieldTable,
  type YieldDecisionRow,
  type YieldOrderRow,
  type YieldScoreRow,
  type YieldTable,
  type YieldTriageRow,
} from "./yield-data.js";

const skTime = (sk: unknown): number => {
  const m = String(sk).match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  return m ? Date.parse(m[0]) : NaN;
};

async function scanStage(table: string, stage: string): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "stage = :s AND begins_with(pk, :n)",
        ExpressionAttributeValues: { ":s": stage, ":n": "NEWS#" },
        ExclusiveStartKey: startKey,
      }),
    );
    out.push(...((r.Items ?? []) as Array<Record<string, any>>));
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

async function scanOrders(table: string): Promise<YieldOrderRow[]> {
  const out: YieldOrderRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :o)",
        ExpressionAttributeValues: { ":o": "ORDER#" },
        ProjectionExpression: "pk, payload",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of (r.Items ?? []) as any[]) {
      let f: any = item.payload;
      if (typeof f === "string") {
        try {
          f = JSON.parse(f);
        } catch {
          continue;
        }
      }
      const notional = Number(f?.notionalUsd ?? f?.notional_usd ?? NaN);
      if (!Number.isFinite(notional)) continue;
      out.push({ decisionId: String(item.pk).replace(/^ORDER#/, ""), notionalUsd: notional });
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

async function queryScores(table: string): Promise<YieldScoreRow[]> {
  const out: YieldScoreRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
        ExpressionAttributeValues: { ":p": "SCOREQ", ":s": "D#" },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const s of (r.Items ?? []) as any[]) {
      out.push({
        actionId: String(s.news_id ?? ""),
        symbol: String(s.symbol ?? ""),
        action: String(s.action ?? ""),
        ret7d: typeof s.ret_7d === "number" ? s.ret_7d : null,
      });
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

export async function computeYieldTable(
  table: string,
  opts: { nowMs?: number } = {},
): Promise<YieldTable> {
  const nowMs = opts.nowMs ?? Date.now();
  const [triageRaw, decisionRaw, scores, orders] = await Promise.all([
    scanStage(table, "v2-triage"),
    scanStage(table, "v2-decision"),
    queryScores(table),
    scanOrders(table),
  ]);
  const triage: YieldTriageRow[] = triageRaw.map((t) => {
    const p = t.payload ?? {};
    return {
      newsId: String(t.pk).replace(/^NEWS#/, ""),
      trigger: "?",
      eventType: typeof p.event_type === "string" ? p.event_type : undefined,
      materiality: Number(p.materiality ?? NaN),
      atMs: skTime(t.sk),
    };
  });
  const decisions: YieldDecisionRow[] = decisionRaw
    .map((d) => {
      const p = d.payload ?? {};
      const newsId = String(d.pk).replace(/^NEWS#/, "");
      const decs: any[] = Array.isArray(p.decisions) ? p.decisions : [];
      return {
        newsId,
        trigger: String(p.trigger ?? "?"),
        costUsd: Number(p.cost_usd ?? 0),
        atMs: skTime(d.sk),
        actions: decs.map((x, i) => ({
          action: String(x.action ?? "hold"),
          symbol: typeof x.symbol === "string" ? x.symbol : null,
          notionalUsd: Number.isFinite(Number(x.notional_usd)) ? Number(x.notional_usd) : null,
          actionId: decs.length === 1 ? newsId : `${newsId}#${i + 1}`,
        })),
      };
    })
    .filter((d) => Number.isFinite(d.atMs) && d.atMs <= nowMs);
  const y = config.yieldTriage;
  return aggregateYield(
    { triage, decisions, scores, orders },
    {
      nowMs,
      halfLifeDays: y.halfLifeDays,
      minN: y.minN,
      maturityDays: y.maturityDays,
      baseThreshold: config.triageThreshold,
      maxShift: y.maxShift,
      floor: y.floor,
      ceil: y.ceil,
    },
  );
}

export async function writeYieldTable(table: string, t: YieldTable): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { pk: "STATE", sk: "YIELD", ...t, written_at: new Date().toISOString() },
    }),
  );
}

export async function readYieldTable(table: string): Promise<YieldTable | null> {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: { pk: "STATE", sk: "YIELD" } }));
  const item = r.Item as (YieldTable & Record<string, unknown>) | undefined;
  if (!item || !Array.isArray(item.categories)) return null;
  return {
    computedAtIso: String(item.computedAtIso),
    params: item.params,
    global: item.global,
    categories: item.categories,
  };
}

/**
 * Cached reader for the worker: one GetItem per refresh interval, never
 * throws, and a read failure keeps the previous table rather than turning the
 * feature off mid-day.
 */
export function yieldTableLoader(table: string, refreshMs: number): { get: () => Promise<YieldTable | null> } {
  let cached: YieldTable | null = null;
  let at = 0;
  let warned = false;
  return {
    async get() {
      if (Date.now() - at < refreshMs) return cached;
      try {
        cached = await readYieldTable(table);
        at = Date.now();
        if (!cached && !warned) {
          console.warn(`[yield] no STATE/YIELD row in ${table}; run \`npm run yield -- --write\`. Flat thresholds apply.`);
          warned = true;
        }
      } catch (e) {
        at = Date.now();
        if (!warned) {
          console.warn("[yield] table read failed; keeping previous table:", e);
          warned = true;
        }
      }
      return cached;
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const arg = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tables = argv.includes("--all") ? [config.table, process.env.V3_TABLE ?? "fin-v3-trading"] : [arg("table") ?? config.table];
  const until = arg("until");
  const nowMs = until ? Date.parse(until) : undefined;
  if (until && !Number.isFinite(nowMs)) throw new Error(`bad --until ${until}`);
  for (const table of tables) {
    const t = await computeYieldTable(table, { nowMs });
    console.log(`\n=== ${table} ===`);
    console.log(renderYieldTable(t));
    if (argv.includes("--write")) {
      await writeYieldTable(table, t);
      console.log(`[yield] wrote STATE/YIELD in ${table} (${t.categories.length} categories)`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("[yield] failed:", e);
    process.exit(1);
  });
}
