// SPDX-License-Identifier: MIT-0
import { pathToFileURL } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { loadArms, armByKey, resourcesOf } from "./arms.js";

/**
 * Seed an arm's paper account (once) and record when it began.
 *
 *   npm run seed -- --arm v2 --cash 100000            # dry run: prints the items it would write
 *   npm run seed -- --arm v2 --cash 100000 --apply    # writes them
 *
 * Writes two rows into the arm's table, each guarded by attribute_not_exists so
 * a second run can never reset a live book:
 *   PORTFOLIO / SNAPSHOT   {cash, realized_pnl_today, day_key}
 *   STATE / INCEPTION      {at}  — the return-since-inception base the dashboard
 *                                  and letter read (readInception); --inception
 *                                  backdates it, e.g. to the first audit row of an
 *                                  account that predates this row.
 * A row that already exists is reported and left alone, so running with only
 * --inception against an existing book adds the missing inception row.
 * Replaces scripts/seed-v2.sh. Dry run by default.
 */

export interface SeedOptions {
  arm: string;
  cash: number;
  /** ISO timestamp; defaults to now. */
  inceptionIso: string;
  /** Explicit table (defaults to the arm's registry table). */
  table?: string;
  /** UTC day key for the snapshot; defaults to today. */
  dayKey?: string;
}

export interface SeedItem {
  table: string;
  item: Record<string, unknown>;
  condition: string;
}

/** Pure: the rows a seed would write. */
export function seedItems(opts: SeedOptions, registry = loadArms()): SeedItem[] {
  const arm = armByKey(opts.arm, registry);
  const table = opts.table ?? resourcesOf(arm, registry).table;
  if (!(opts.cash > 0) || !Number.isFinite(opts.cash)) throw new Error(`--cash must be a positive number (got ${opts.cash})`);
  const at = new Date(opts.inceptionIso);
  if (Number.isNaN(at.getTime())) throw new Error(`--inception is not a date: ${opts.inceptionIso}`);
  const iso = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    {
      table,
      item: { pk: "PORTFOLIO", sk: "SNAPSHOT", cash: opts.cash, realized_pnl_today: 0, day_key: opts.dayKey ?? new Date().toISOString().slice(0, 10) },
      condition: "attribute_not_exists(pk)",
    },
    { table, item: { pk: "STATE", sk: "INCEPTION", at: iso }, condition: "attribute_not_exists(pk)" },
  ];
}

export interface SeedArgs extends SeedOptions {
  apply: boolean;
  region: string;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): SeedArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const arm = get("--arm") ?? env.V2_ARM;
  if (!arm) throw new Error("usage: seed --arm <key> --cash <usd> [--inception <iso>] [--table <name>] [--region <r>] [--apply]");
  return {
    arm,
    cash: Number(get("--cash") ?? "100000"),
    inceptionIso: get("--inception") ?? new Date().toISOString(),
    table: get("--table"),
    region: get("--region") ?? env.AWS_REGION ?? "us-east-1",
    apply: argv.includes("--apply"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const items = seedItems(args);
  const mode = args.apply ? "APPLY" : "DRY RUN";
  console.log(`[seed] ${mode} — arm ${args.arm}, table ${items[0].table}, region ${args.region}`);
  for (const it of items) console.log(`  put ${it.item.pk}/${it.item.sk} if ${it.condition}: ${JSON.stringify(it.item)}`);
  if (!args.apply) {
    console.log("[seed] nothing written (pass --apply to write)");
    return;
  }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
  for (const it of items) {
    try {
      await ddb.send(new PutCommand({ TableName: it.table, Item: it.item, ConditionExpression: it.condition }));
      console.log(`[seed] wrote ${it.item.pk}/${it.item.sk}`);
    } catch (e: any) {
      if (e?.name === "ConditionalCheckFailedException") {
        console.log(`[seed] ${it.item.pk}/${it.item.sk} already exists — left alone`);
        continue;
      }
      throw e;
    }
  }
}

// Entry point only when run directly: importing this module must never write.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[seed]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
