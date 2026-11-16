// SPDX-License-Identifier: MIT-0
import { pathToFileURL } from "node:url";
import { asksFor, bidsFor, clientOrderIdFor, fromCreateOrderResponse, parseKalshiSymbol, parseOrderbook, toCreateOrder } from "./kalshi-core.js";
import { credentialsFromEnv, KalshiClient, type KalshiEnv } from "./kalshi-client.js";

/**
 * Operator CLI for the live setup (docs/LIVE_TRADING.md). Reads only, except `test-order`, which
 * refuses anything but the DEMO exchange: it exists to confirm, with play money, the one thing the
 * docs leave open — which book `average_fill_price` is quoted on for a NO order.
 *
 *   node dist/live/cli.js status        --env demo|prod     balance, positions (needs a key)
 *   node dist/live/cli.js book TICKER   [--env prod]        public book, top 5 each side
 *   node dist/live/cli.js test-order SYMBOL buy|sell COUNT LIMIT --env demo
 * Credentials: V2_KALSHI_KEY_ID + V2_KALSHI_KEY_PATH (or V2_KALSHI_KEY_PEM).
 */

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const env = arg("env", cmd === "book" ? "prod" : "demo") as KalshiEnv;
  if (env !== "demo" && env !== "prod") throw new Error(`--env must be demo or prod, got ${env}`);
  const client = new KalshiClient(env, cmd === "book" ? null : credentialsFromEnv());

  if (cmd === "status") {
    const [bal, pos] = await Promise.all([client.balance(), client.positions()]);
    console.log(JSON.stringify({ env, cash_usd: Number(bal.balance) / 100, portfolio_value_usd: Number(bal.portfolio_value) / 100, positions: (pos.market_positions ?? []).filter((p: any) => Number(p.position_fp)).map((p: any) => ({ ticker: p.ticker, position: p.position_fp, exposure: p.market_exposure_dollars, realized: p.realized_pnl_dollars, fees: p.fees_paid_dollars })) }, null, 1));
    return;
  }
  if (cmd === "book") {
    const ticker = rest[0];
    if (!ticker) throw new Error("usage: book TICKER");
    const b = parseOrderbook(await client.orderbook(ticker));
    for (const side of ["YES", "NO"] as const) console.log(side, "asks", asksFor(b, side).slice(0, 5), "bids", bidsFor(b, side).slice(0, 5));
    return;
  }
  if (cmd === "test-order") {
    if (env !== "demo") throw new Error("test-order runs on the demo exchange only (--env demo)");
    const [symbol, action, count, limit] = rest;
    const k = parseKalshiSymbol(symbol ?? "");
    if (!k || (action !== "buy" && action !== "sell") || !(Number(count) > 0) || !(Number(limit) > 0 && Number(limit) < 1)) {
      throw new Error("usage: test-order KXTICKER:YES|NO buy|sell COUNT LIMIT --env demo");
    }
    const intent = { ticker: k.ticker, side: k.side, action, count: Number(count), limitPrice: Number(limit) } as const;
    const order = toCreateOrder(intent, clientOrderIdFor(`cli-${Date.now()}`));
    console.log("sending", order);
    const resp = await client.createOrder(order);
    console.log("response", resp);
    console.log("read back as", fromCreateOrderResponse(resp, intent), "(check avgPrice against the demo UI before any prod order)");
    return;
  }
  throw new Error("usage: status | book TICKER | test-order SYMBOL buy|sell COUNT LIMIT --env demo");
}

// Entry point only when run directly (CLAUDE.md: importing a module must never run it).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[live-cli]", String(e?.message ?? e));
    process.exit(1);
  });
}
