// SPDX-License-Identifier: MIT-0
/**
 * Marking the paper books. One arm = one DynamoDB table; `markArm` reads its
 * portfolio, positions, fills and daily equity snapshots and marks every
 * position at liquidation value (bid for longs, ask for shorts) through the
 * resolver — the same rule the letter, scorer and watcher use. `buildCurve`
 * turns the arms' snapshots plus the SPY/QQQ/GLD/USO benchmarks into the
 * indexed series the equity chart draws. The arms come from the registry
 * (`arms.json`); the focus arm is `config.arm`.
 *
 * Shared by the dashboard (`dashboard.ts`) and the leaderboard
 * (`leaderboard.ts`) so both show the same numbers. Reads only; nothing here
 * writes. Not imported by tests (it reaches `daily-report.ts`, an entry point):
 * the pure shaping lives in `dashboard-data.ts` and `leaderboard-data.ts`.
 */
import { config, arms } from "./config.js";
import { tableFor, type Arm as ArmDef } from "./arms.js";
import { getPortfolioOf, listPositions } from "./ledger.js";
import { resolve, inferKind } from "./quotes/resolver.js";
import { yahooDailyCloses } from "./quotes/yahoo.js";
import { liquidationPrice } from "./exec.js";
import { BENCHMARKS, pickBase } from "./performance.js";
import { gatherFills, impliedSeed, readSnapshots, readInception } from "./daily-report.js";
import { indexedSeries, dayNoonMs, armRole, orderArmKeys, type CurveSeries, type ArmRole } from "./dashboard-data.js";

export interface DashPosition {
  symbol: string;
  kind: string;
  side: "long" | "short";
  qty: number;
  avgCost: number;
  costBasis: number;
  mark: number;
  bid: number | null;
  ask: number | null;
  depth: number | null;
  unrealized: number;
  weightPct: number;
  resolved: boolean;
  quotable: boolean;
  source: string | null;
}

export interface Arm {
  key: string;
  label: string;
  kind: "agent" | "pipeline";
  worldModel: boolean;
  /** focus = config.arm; identity = a pipeline arm; arm = another agent arm. */
  role: ArmRole;
  table: string;
  seed: number;
  equity: number;
  cash: number;
  positionsValue: number;
  realized: number;
  unrealized: number;
  returnPct: number;
  inceptionIso: string | null;
  fills: number;
  buyNotional: number;
  positions: DashPosition[];
  snapshots: { day: string; equity: number }[];
}

/** Return of one benchmark since the focus arm's inception. */
export interface BenchmarkView {
  symbol: string;
  label: string;
  returnPct: number | null;
}

export const FOCUS = config.arm;
/**
 * The arms shown: the registry, plus a synthesized entry when V2_ARM
 * names an arm the registry does not know (brought up env-first).
 */
export const ARM_DEFS: ArmDef[] = arms.arms.some((a) => a.key === FOCUS)
  ? arms.arms
  : [
      { key: FOCUS, kind: "agent", label: config.armLabel, model: config.masterModel, effort: null, worldModel: config.worldModel, dailyBudgetUsd: null },
      ...arms.arms,
    ];
export const ARM_KEYS = orderArmKeys(ARM_DEFS, FOCUS);

export function tableOf(def: ArmDef): string {
  return tableFor(def, arms, { key: FOCUS, table: config.table });
}

export async function markArm(def: ArmDef): Promise<Arm | null> {
  const table = tableOf(def);
  const [portfolio, positions, fills, snapshots, inception] = await Promise.all([
    getPortfolioOf(table),
    listPositions(table),
    gatherFills(table),
    readSnapshots(def.key),
    readInception(table),
  ]);
  if (!portfolio) return null;
  const rows: DashPosition[] = [];
  for (const p of positions) {
    const kind = String((p.kind as string | undefined) ?? inferKind(p.symbol));
    const res = await resolve(p.symbol, kind as any).catch(() => null);
    const ok = !!res && res.ok;
    const mark = ok ? liquidationPrice(res.quote, p.qty) : p.avg_cost;
    rows.push({
      symbol: p.symbol,
      kind,
      side: p.qty < 0 ? "short" : "long",
      qty: p.qty,
      avgCost: p.avg_cost,
      costBasis: p.qty * p.avg_cost,
      mark,
      bid: ok ? (res.quote.bid ?? null) : null,
      ask: ok ? (res.quote.ask ?? null) : null,
      depth: ok ? (res.quote.liquidityUsd ?? null) : null,
      unrealized: (mark - p.avg_cost) * p.qty,
      weightPct: 0,
      resolved: ok ? !!res.quote.resolved : false,
      quotable: ok,
      source: ok ? res.quote.source : null,
    });
  }
  const positionsValue = rows.reduce((s, r) => s + r.qty * r.mark, 0);
  const equity = portfolio.cash + positionsValue;
  for (const r of rows) r.weightPct = equity > 0 ? ((r.qty * r.mark) / equity) * 100 : 0;
  const seed = impliedSeed(
    portfolio.cash,
    rows.map((r) => ({ symbol: r.symbol, qty: r.qty, avgCost: r.avgCost, mark: r.mark })),
    fills.realized,
  );
  // V2_INCEPTION (focus arm only) > STATE/INCEPTION written by seed.ts > the first fill.
  const inceptionIso = (def.key === FOCUS ? config.inceptionIso : undefined) ?? inception ?? fills.firstAtIso;
  return {
    key: def.key,
    label: def.label,
    kind: def.kind,
    worldModel: def.worldModel,
    role: armRole(def, FOCUS),
    table,
    seed,
    equity,
    cash: portfolio.cash,
    positionsValue,
    realized: fills.realized,
    unrealized: rows.reduce((s, r) => s + r.unrealized, 0),
    returnPct: seed > 0 ? ((equity - seed) / seed) * 100 : 0,
    inceptionIso,
    fills: fills.fills,
    buyNotional: fills.buyNotional,
    positions: rows.sort((a, b) => b.qty * b.mark - a.qty * a.mark),
    snapshots: snapshots.map((s) => ({ day: s.at, equity: s.equity })),
  };
}

export async function buildCurve(
  ordered: Arm[],
  focus: Arm | null,
  nowMs: number,
): Promise<{ curve: CurveSeries[]; benchmarks: BenchmarkView[] }> {
  const inceptionMs = focus?.inceptionIso ? Date.parse(focus.inceptionIso) : NaN;
  const seed = focus?.seed ?? 100_000;
  const curve: CurveSeries[] = [];
  const armSeries = (arm: Arm, role: CurveSeries["role"], withSeed: boolean): CurveSeries => {
    const pts = arm.snapshots.map((s) => ({ tMs: dayNoonMs(s.day), value: s.equity }));
    const armInception = arm.inceptionIso ? Date.parse(arm.inceptionIso) : inceptionMs;
    if (withSeed) pts.unshift({ tMs: armInception, value: arm.seed });
    pts.push({ tMs: nowMs, value: arm.equity });
    return {
      key: arm.key,
      label: arm.label,
      role,
      points: pts.filter((p) => Number.isFinite(p.tMs)).sort((a, b) => a.tMs - b.tMs),
    };
  };
  // A pipeline arm was seeded earlier and is shown at actual equity, without a seed point.
  for (const arm of ordered) curve.push(armSeries(arm, arm.role, arm.role !== "identity"));
  const benchmarks: BenchmarkView[] = [];
  await Promise.all(
    BENCHMARKS.map(async (spec) => {
      try {
        if (!Number.isFinite(inceptionMs)) throw new Error("focus arm inception unknown");
        const closes = await yahooDailyCloses(spec.symbol, "3mo");
        const picked = pickBase(closes, inceptionMs);
        if (!picked) throw new Error("no closes");
        const pts = indexedSeries(closes, picked.base.close, picked.base.tMs, seed);
        const last = pts.at(-1);
        benchmarks.push({
          symbol: spec.symbol,
          label: spec.label,
          returnPct: last ? ((last.value - seed) / seed) * 100 : null,
        });
        curve.push({ key: spec.symbol, label: spec.symbol, role: "context", points: pts });
      } catch (e) {
        benchmarks.push({ symbol: spec.symbol, label: spec.label, returnPct: null });
        console.warn(`[books] benchmark ${spec.symbol} unavailable:`, e);
      }
    }),
  );
  // Fixed order: focus, the other agent arms, pipeline arms, then benchmarks in their documented order.
  const order = [...ARM_KEYS, ...BENCHMARKS.map((b) => b.symbol)];
  curve.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  benchmarks.sort((a, b) => order.indexOf(a.symbol) - order.indexOf(b.symbol));
  return { curve, benchmarks };
}
