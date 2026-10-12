// SPDX-License-Identifier: MIT-0
import { yahooDailyCloses, type DailyClose } from "./quotes/yahoo.js";

/**
 * Portfolio performance in the terms an investor actually asks about: how much
 * capital is at work, what it returned, and how that compares with having done
 * nothing but hold the market over the same window.
 *
 * Pure functions only (plus the benchmark fetch) so the letter's headline
 * numbers are testable and reconcile against the ledger.
 */

export interface PerfPosition {
  symbol: string;
  qty: number;
  avgCost: number;
  /** Liquidation mark (bid), per exec.liquidationPrice — never mid. */
  mark: number;
}

export interface PerfInput {
  seedCash: number;
  inceptionMs: number;
  nowMs: number;
  cash: number;
  positions: PerfPosition[];
  /** Sum of realized P&L over every fill ever booked. */
  realizedToDate: number;
  /** Sum of buy notional over every fill ever booked (capital ever committed). */
  buyNotionalToDate: number;
  fills: number;
}

export interface Perf {
  equity: number;
  marketValue: number;
  totalPnl: number;
  totalReturnPct: number;
  realized: number;
  unrealized: number;
  /** Cost basis of open positions: the capital currently at work. */
  deployedCost: number;
  deployedPct: number;
  /** Positions at mark, as a share of equity. This plus cashPct is 100%. */
  marketValuePct: number;
  cashPct: number;
  capitalCommitted: number;
  returnOnCommittedPct: number;
  fills: number;
  days: number;
  /** realized + unrealized should equal equity - seed. Guards silent ledger drift. */
  reconciles: boolean;
  /** Short side at mark (absolute), and gross exposure (longs + |shorts|) as a share of equity. */
  shortMarketValue: number;
  grossExposurePct: number;
}

function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}

export function computePerf(i: PerfInput): Perf {
  const marketValue = i.positions.reduce((s, p) => s + p.qty * p.mark, 0);
  const deployedCost = i.positions.reduce((s, p) => s + p.qty * p.avgCost, 0);
  const equity = i.cash + marketValue;
  const shortMarketValue = i.positions.filter((p) => p.qty < 0).reduce((s, p) => s + Math.abs(p.qty * p.mark), 0);
  const grossExposure = i.positions.reduce((s, p) => s + Math.abs(p.qty * p.mark), 0);
  const unrealized = marketValue - deployedCost;
  const totalPnl = equity - i.seedCash;
  return {
    equity,
    marketValue,
    totalPnl,
    totalReturnPct: pct(totalPnl, i.seedCash),
    realized: i.realizedToDate,
    unrealized,
    deployedCost,
    deployedPct: pct(deployedCost, equity),
    marketValuePct: pct(marketValue, equity),
    cashPct: pct(i.cash, equity),
    capitalCommitted: i.buyNotionalToDate,
    returnOnCommittedPct: pct(totalPnl, i.buyNotionalToDate),
    fills: i.fills,
    days: Math.max(0, (i.nowMs - i.inceptionMs) / 86_400_000),
    reconciles: Math.abs(i.realizedToDate + unrealized - totalPnl) < 1,
    shortMarketValue,
    grossExposurePct: pct(grossExposure, equity),
  };
}

export interface BenchmarkSpec {
  symbol: string;
  label: string;
}

/**
 * What the money could have done instead. SPY/QQQ for "just own the market",
 * GLD for the macro-hedge alternative, USO because oil has driven most of the
 * book's P&L and the fair question is whether the agent beat owning the theme.
 */
export const BENCHMARKS: BenchmarkSpec[] = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq 100" },
  { symbol: "GLD", label: "gold" },
  { symbol: "USO", label: "WTI crude" },
];

export interface BenchmarkReturn extends BenchmarkSpec {
  basePrice: number | null;
  baseAtMs: number | null;
  lastPrice: number | null;
  lastAtMs: number | null;
  returnPct: number | null;
  /** True when no close existed at or before inception, so the base is later. */
  baseAfterInception: boolean;
}

/**
 * The comparison base is the last close at or before inception: capital seeded
 * on a Sunday competes with a market you could only have bought on Friday.
 */
export function pickBase(
  closes: DailyClose[],
  inceptionMs: number,
): { base: DailyClose; afterInception: boolean } | null {
  if (closes.length === 0) return null;
  const sorted = [...closes].sort((a, b) => a.tMs - b.tMs);
  let base: DailyClose | null = null;
  for (const c of sorted) {
    if (c.tMs <= inceptionMs) base = c;
    else break;
  }
  if (base) return { base, afterInception: false };
  return { base: sorted[0], afterInception: true };
}

export async function benchmarkReturns(
  inceptionMs: number,
  specs: BenchmarkSpec[] = BENCHMARKS,
  range = "3mo",
): Promise<BenchmarkReturn[]> {
  return Promise.all(
    specs.map(async (spec) => {
      const empty: BenchmarkReturn = {
        ...spec,
        basePrice: null,
        baseAtMs: null,
        lastPrice: null,
        lastAtMs: null,
        returnPct: null,
        baseAfterInception: false,
      };
      try {
        const closes = await yahooDailyCloses(spec.symbol, range);
        const picked = pickBase(closes, inceptionMs);
        const last = closes.length > 0 ? closes[closes.length - 1] : null;
        if (!picked || !last || picked.base.close <= 0) return empty;
        return {
          ...spec,
          basePrice: picked.base.close,
          baseAtMs: picked.base.tMs,
          lastPrice: last.close,
          lastAtMs: last.tMs,
          returnPct: ((last.close - picked.base.close) / picked.base.close) * 100,
          baseAfterInception: picked.afterInception,
        };
      } catch {
        return empty;
      }
    }),
  );
}

const sign = (n: number): string => (n >= 0 ? "+" : "");
const d0 = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/**
 * The letter's opening section. Every dollar figure carries the base it is a
 * percentage of; the model is told elsewhere never to quote one without it.
 */
export function formatPerf(
  p: Perf,
  seedCash: number,
  inceptionIso: string,
  benchmarks: BenchmarkReturn[],
  llmSpendToDate: number | null,
  priorEquity: { equity: number; at: string } | null,
  reference: { equity: number; seedCash: number; inceptionIso: string } | null,
): string {
  const out: string[] = [];
  out.push(`### Performance (paper account — no real money at risk)`);
  out.push(
    `seed capital: $${d0(seedCash)} on ${inceptionIso.slice(0, 10)} (${p.days.toFixed(1)} days ago)`,
  );
  out.push(
    `equity now: $${d0(p.equity)} = cash $${d0(p.equity - p.marketValue)} + positions at liquidation value $${d0(p.marketValue)}`,
  );
  out.push(
    `total P&L: ${sign(p.totalPnl)}$${d0(p.totalPnl)} = ${sign(p.totalReturnPct)}${p.totalReturnPct.toFixed(2)}% on seed capital`,
  );
  out.push(`  realized: ${sign(p.realized)}$${d0(p.realized)}`);
  out.push(`  unrealized: ${sign(p.unrealized)}$${d0(p.unrealized)}`);
  out.push(`  ledger reconciles: ${p.reconciles ? "yes" : "NO — investigate"}`);
  if (priorEquity) {
    const chg = p.equity - priorEquity.equity;
    out.push(
      `since previous snapshot (${priorEquity.at}): ${sign(chg)}$${d0(chg)} = ${sign(chg)}${pct(chg, priorEquity.equity).toFixed(2)}%`,
    );
  }
  out.push(
    `capital at work: $${d0(p.deployedCost)} of cost basis (${p.deployedPct.toFixed(1)}% of equity), now marked at $${d0(p.marketValue)} (${p.marketValuePct.toFixed(1)}%). Cash is $${d0(p.equity - p.marketValue)} = ${p.cashPct.toFixed(1)}% of equity and earns 0% in this simulation. Cost basis exceeds the mark because the positions are underwater, so cost% + cash% tops 100%.`,
  );
  out.push(
    `capital ever committed: $${d0(p.capitalCommitted)} across ${p.fills} fills; P&L is ${sign(p.returnOnCommittedPct)}${p.returnOnCommittedPct.toFixed(2)}% of that`,
  );
  out.push(`benchmarks over the same window (last close at or before inception -> latest close):`);
  for (const b of benchmarks) {
    if (b.returnPct === null) {
      out.push(`  ${b.label} (${b.symbol}): unavailable`);
      continue;
    }
    const wouldBe = seedCash * (1 + b.returnPct / 100);
    out.push(
      `  ${b.label} (${b.symbol}): ${sign(b.returnPct)}${b.returnPct.toFixed(2)}% — $${d0(seedCash)} held would be $${d0(wouldBe)}${b.baseAfterInception ? " (base is AFTER inception; understates)" : ""}`,
    );
  }
  if (llmSpendToDate !== null) {
    out.push(
      `real cost of running the agent: $${llmSpendToDate.toFixed(2)} of LLM spend to date = ${pct(llmSpendToDate, p.equity).toFixed(3)}% of equity — every metered investigation since inception, replay benches included. This is REAL money; the P&L above is simulated.`,
    );
  }
  if (reference) {
    const refPnl = reference.equity - reference.seedCash;
    out.push(
      `v1 reference arm (same news feed, gated pipeline): equity $${d0(reference.equity)}, ${sign(refPnl)}${pct(refPnl, reference.seedCash).toFixed(2)}% on the same $${d0(reference.seedCash)} seed, but running since ${reference.inceptionIso.slice(0, 10)} — a LONGER window than v2, so the two returns are not directly comparable yet.`,
    );
  }
  out.push(
    `sample: ${p.days.toFixed(1)} days and ${p.fills} fills. Far too short to annualize or to distinguish skill from luck.`,
  );
  return out.join("\n");
}
