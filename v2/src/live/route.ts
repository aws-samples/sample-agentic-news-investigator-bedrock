// SPDX-License-Identifier: MIT-0
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "../config.js";
import { executeDecision, type ExecOutcome } from "../exec.js";
import * as ledger from "../ledger.js";
import type { Resolution, TradeDecision } from "../types.js";
import { executeLive, reconcile, type LiveDeps } from "./broker.js";
import { exchangePositions } from "./kalshi-core.js";
import { putAudit } from "../audit.js";
import { credentialsFromEnv, KalshiClient } from "./kalshi-client.js";
import { sourceEnabled } from "../sources.js";

/**
 * The one switch between paper and real money. Every caller that used executeDecision for a fresh
 * order (pipeline.ts, pending.ts) calls execute(): with V2_LIVE off it IS executeDecision, so the
 * experiment arms are unchanged; with demo/prod it goes to the live broker.
 */
export function execute(
  decision: TradeDecision & { action: "buy" | "sell" },
  decisionId: string,
  resolveFn: (symbol: string, kind?: any) => Promise<Resolution>,
  newsId: string = decisionId,
): Promise<ExecOutcome> {
  if (config.live === "off") return executeDecision(decision, decisionId, resolveFn, newsId);
  return executeLive(decision, decisionId, newsId, liveDeps());
}

let deps: LiveDeps | null = null;

export function liveClient(): KalshiClient {
  if (config.live === "off") throw new Error("live client requested with V2_LIVE=off");
  return new KalshiClient(config.live, credentialsFromEnv());
}

function liveDeps(): LiveDeps {
  if (deps) return deps;
  const ssm = new SSMClient({ region: config.region });
  deps = {
    client: liveClient(),
    async halted() {
      // Kalshi is an opt-in source (sources.ts): without it the live arm makes no call at all.
      if (!sourceEnabled("kalshi")) return "kalshi is not in V2_ENABLE_SOURCES";
      // Fail closed: trading needs the parameter to read exactly "false".
      const r = await ssm.send(new GetParameterCommand({ Name: config.liveKillSwitchParam }));
      const v = (r.Parameter?.Value ?? "").trim();
      return v === "false" ? null : `live kill switch ${config.liveKillSwitchParam} = "${v || "(missing)"}"`;
    },
    async dayStartEquity(equityUsd) {
      const key = { pk: "LIVE", sk: `DAY#${new Date().toISOString().slice(0, 10)}` };
      await ledger.ddb
        .send(new PutCommand({ TableName: config.table, Item: { ...key, equity_usd: equityUsd, at: new Date().toISOString() }, ConditionExpression: "attribute_not_exists(pk)" }))
        .catch((e) => {
          if (e?.name !== "ConditionalCheckFailedException") throw e;
        });
      const r = await ledger.ddb.send(new GetCommand({ TableName: config.table, Key: key }));
      return r.Item ? Number(r.Item.equity_usd) : null;
    },
    ledgerPosition: (symbol) => ledger.getPosition(symbol),
    recordFill: (fill, position) => ledger.recordFill(fill, position),
    limits: config.liveLimits,
    slippageTolerance: config.liveSlippageTolerance,
  };
  return deps;
}

/** Public order book for shadow mode: no key, prod by default (the market the paper arm mirrors). */
const publicBooks = new KalshiClient(config.live === "demo" ? "demo" : "prod", null);
export function liveShadowBook(ticker: string): Promise<any> {
  return publicBooks.orderbook(ticker);
}

/**
 * Ledger vs exchange (worker.ts, every 15 min while live). A difference is audited as
 * `v2-live-reconcile` under NEWS#live-reconcile-<date> and logged; nothing is corrected
 * automatically — the operator decides whether the ledger or the exchange is wrong.
 */
export async function reconcilePass(): Promise<number> {
  const [ledgerPositions, pos] = await Promise.all([ledger.listPositions(), liveClient().positions()]);
  const diff = reconcile(ledgerPositions.map((p) => ({ symbol: p.symbol, qty: p.qty })), exchangePositions(pos));
  if (diff.length) {
    console.warn(`[live] reconcile: ${diff.length} position(s) differ from the exchange:`, JSON.stringify(diff));
    await putAudit(`live-reconcile-${new Date().toISOString().slice(0, 10)}`, "v2-live-reconcile", { diff, at: new Date().toISOString() });
  }
  return diff.length;
}
