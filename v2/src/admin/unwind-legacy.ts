// SPDX-License-Identifier: MIT-0
/**
 * One-off book correction: reverse positions AT COST.
 *
 *   node dist/admin/unwind-legacy.js --symbols "SYM1,SYM2" --reason "..." [--confirm]
 *
 * Runs against config.table (set V2_TABLE for another arm). Without --confirm it
 * only prints what it would do. With it, each position is closed by a synthetic
 * fill at its average cost — realized P&L 0, quoteSource "book-correction" —
 * through ledger.recordFill, the same atomic transaction a real fill uses, so
 * cash, the POSITION# row and the ORDER# history stay consistent; and a
 * `v2-book-correction` audit row records why (the letter reports it as an
 * administrative reversal, not a trade).
 *
 * Why at cost: this exists for fills that could never have happened under the
 * broker's rules (25% of the resting book) — 2026-09-08: 37,175 TX-landfall and
 * 14,305 LA-landfall contracts bought in Aug/Sep into $16–$128 books before the
 * liquidity cap existed, unsellable at any speed since. Undoing them at cost
 * neither credits nor debits the experiment for a size the rules forbid; the
 * agent's decision rows and their outcome scores stand as the record of its
 * judgment. Not a general tool: never use it to erase a loss the rules allowed.
 */
import { config } from "../config.js";
import * as ledger from "../ledger.js";
import { putAudit } from "../audit.js";
import { resolve } from "../quotes/resolver.js";
import { liquidationPrice, round8 } from "../exec.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const symbols = (arg("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const reason = arg("reason") ?? "";
  const confirm = process.argv.includes("--confirm");
  if (symbols.length === 0 || !reason) {
    console.error('usage: unwind-legacy --symbols "A,B" --reason "why" [--confirm]');
    process.exit(2);
  }
  const day = new Date().toISOString().slice(0, 10);
  const newsId = `correction-${day}`;
  const before = await ledger.getPortfolio();
  if (!before) throw new Error(`no PORTFOLIO/SNAPSHOT in ${config.table}`);
  console.log(`table ${config.table} — cash before $${before.cash.toFixed(2)} — ${confirm ? "APPLYING" : "dry run"}`);

  let i = 0;
  let cashBack = 0;
  let unrealizedRemoved = 0;
  for (const symbol of symbols) {
    const pos = await ledger.getPosition(symbol);
    if (!pos || pos.qty === 0) {
      console.log(`  ${symbol}: no position — skipped`);
      continue;
    }
    i++;
    const res = await resolve(symbol, (pos.kind as any) ?? "auto");
    const mark = res.ok ? liquidationPrice(res.quote, pos.qty) : pos.avg_cost;
    const qty = Math.abs(pos.qty);
    const side: "buy" | "sell" = pos.qty > 0 ? "sell" : "buy";
    const costBasis = round8(qty * pos.avg_cost);
    const markValue = round8(qty * mark);
    const unrealized = round8((mark - pos.avg_cost) * pos.qty);
    cashBack += pos.qty > 0 ? costBasis : -costBasis;
    unrealizedRemoved += unrealized;
    console.log(
      `  ${symbol}: ${side} ${qty} at cost ${pos.avg_cost} = $${costBasis.toFixed(2)} ` +
        `(marked ${mark}${res.ok ? "" : " [unquotable, using cost]"} = $${markValue.toFixed(2)}, unrealized ${unrealized >= 0 ? "+" : ""}$${unrealized.toFixed(2)} removed)`,
    );
    if (!confirm) continue;

    const filledAt = new Date().toISOString();
    const fill: ledger.Fill = {
      decisionId: `${newsId}#${i}`,
      newsId,
      symbol,
      kind: pos.kind ?? (res.ok ? res.quote.kind : "unknown"),
      side,
      qty,
      quotePrice: pos.avg_cost,
      fillPrice: pos.avg_cost,
      slippageBps: 0,
      notionalUsd: costBasis,
      quoteSource: "book-correction",
      realizedPnl: 0,
      filledAt,
    };
    await ledger.recordFill(fill, { newQty: 0, newAvgCost: 0, expectedQty: pos.qty });
    await putAudit(newsId, "v2-book-correction", {
      headline: `Book correction: ${side} ${qty} ${symbol} reversed at cost ${pos.avg_cost} — ${reason}`,
      symbol,
      qty: pos.qty,
      avg_cost: pos.avg_cost,
      cost_basis_usd: costBasis,
      mark,
      mark_value_usd: markValue,
      unrealized_removed_usd: unrealized,
      reason,
      fill,
    });
    console.log(`    reversed (ORDER#${fill.decisionId})`);
  }

  const after = confirm ? await ledger.getPortfolio() : null;
  console.log(
    `${confirm ? "done" : "would return"}: $${cashBack.toFixed(2)} to cash` +
      (after ? ` — cash now $${after.cash.toFixed(2)}` : ` — cash would be $${(before.cash + cashBack).toFixed(2)}`) +
      `; unrealized removed ${unrealizedRemoved >= 0 ? "+" : ""}$${unrealizedRemoved.toFixed(2)} (equity moves by the opposite: ${-unrealizedRemoved >= 0 ? "+" : ""}$${(-unrealizedRemoved).toFixed(2)})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
