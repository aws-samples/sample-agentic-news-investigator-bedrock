// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { runVariant, watchlistFrom, simBookView, pushThesis, type BenchEvent, type RunDeps, type BookView } from "../src/bench/run.js";
import { SimBook } from "../src/bench/book.js";
import type { Strategy, StrategyInput, StrategyResult } from "../src/strategy.js";
import type { InstrumentKind, NewsItem, Resolution, TradeDecision } from "../src/types.js";
import { config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Fixtures: three events on consecutive days and a price table by symbol.
// ---------------------------------------------------------------------------

const T = (iso: string) => Date.parse(iso);
const D1 = "2026-08-24T14:00:00.000Z";
const D2 = "2026-08-25T14:00:00.000Z";
const D3 = "2026-08-26T14:00:00.000Z";
const WINDOW_END = T("2026-09-01T00:00:00.000Z");
const NOW = T("2026-09-10T00:00:00.000Z");

function news(id: string, published_at: string, headline = `headline ${id}`): NewsItem {
  return {
    id,
    source_family: "test",
    source_id: id,
    published_at,
    ingested_at: published_at,
    headline,
    summary: "",
    url: "https://example.com/" + id,
    tickers_hint: [],
  };
}

function ev(id: string, at: string, passed = true): BenchEvent {
  return { item: news(id, at), hypotheses: [`h-${id}`], materiality: passed ? 0.7 : 0.1, passed };
}

type Tick = { tMs: number; bid: number; ask: number; liq?: number };
type Table = Record<string, Tick[]>;

function table(): Table {
  return {
    ARGT: [
      { tMs: T(D1), bid: 9.9, ask: 10 },
      { tMs: T(D2), bid: 11, ask: 11.1 },
      { tMs: T(D3), bid: 11.5, ask: 11.6 },
      { tMs: T("2026-08-31T14:00:00.000Z"), bid: 11.8, ask: 11.9 },
      { tMs: WINDOW_END, bid: 12, ask: 12.1 },
    ],
    SPY: [
      { tMs: T(D2), bid: 500, ask: 500.1 },
      { tMs: T(D3), bid: 505, ask: 505.1 },
      { tMs: T("2026-09-01T14:00:00.000Z"), bid: 510, ask: 510.1 },
    ],
    XYZ: [
      { tMs: T(D3), bid: 50, ask: 50.1 },
      { tMs: T("2026-08-27T14:00:00.000Z"), bid: 45, ask: 45.1 },
      { tMs: WINDOW_END, bid: 40, ask: 40.1 },
    ],
  };
}

function lastAtOrBefore(ticks: Tick[] | undefined, ms: number): Tick | null {
  if (!ticks) return null;
  let best: Tick | null = null;
  for (const t of ticks) if (t.tMs <= ms && (!best || t.tMs > best.tMs)) best = t;
  return best;
}

function fakeDeps(prices: Table, overrides: Partial<RunDeps> = {}): RunDeps & { audits: unknown[]; spend: number[] } {
  const audits: unknown[] = [];
  const spend: number[] = [];
  const resolveAsOf = async (symbol: string, kind: InstrumentKind | "auto", asOfMs: number): Promise<Resolution> => {
    const t = lastAtOrBefore(prices[symbol], asOfMs);
    if (!t) return { ok: false, reason: `no price for ${symbol}` };
    return {
      ok: true,
      quote: {
        symbol,
        kind: kind === "auto" ? "equity" : kind,
        price: (t.bid + t.ask) / 2,
        bid: t.bid,
        ask: t.ask,
        asOfMs: t.tMs,
        source: "fake",
        ...(t.liq !== undefined ? { liquidityUsd: t.liq } : {}),
      },
      meta: { hasBook: true, ageSecs: Math.max(0, (asOfMs - t.tMs) / 1000), indicativeOnly: false },
    };
  };
  const historicalReturn: RunDeps["historicalReturn"] = async (symbol, _kind, action, entryMs, horizonMs) => {
    const e = lastAtOrBefore(prices[symbol], entryMs);
    const x = lastAtOrBefore(prices[symbol], entryMs + horizonMs);
    if (!e || !x || x.tMs <= e.tMs) return null;
    const long = action !== "sell";
    const entry = long ? e.ask : e.bid;
    const exit = long ? x.bid : x.ask;
    const ret = long ? exit / entry - 1 : entry / exit - 1;
    return { entry, exit, ret };
  };
  return {
    resolveAsOf,
    historicalReturn,
    audit: async (_id, _stage, payload) => {
      audits.push(payload);
    },
    addSpend: async (usd) => {
      spend.push(usd);
    },
    nowMs: NOW,
    audits,
    spend,
    ...overrides,
  };
}

type Script = Record<string, Partial<StrategyResult> | ((input: StrategyInput) => Promise<Partial<StrategyResult>>)>;

/** A Strategy driven by a per-event script; records every input it saw. */
function scripted(name: string, script: Script, cost = 0.5): Strategy & { seen: StrategyInput[] } {
  const seen: StrategyInput[] = [];
  return {
    name,
    description: `scripted ${name}`,
    seen,
    async decide(input) {
      seen.push(input);
      const entry = script[input.item.id];
      const partial = typeof entry === "function" ? await entry(input) : entry ?? {};
      return {
        decisions: partial.decisions ?? [{ action: "hold", confidence: 0.6, rationale: "nothing", evidence: [] }],
        costUsd: partial.costUsd ?? cost,
        numTurns: partial.numTurns ?? 3,
        degraded: true,
        transcriptUri: null,
        finalText: "",
        errored: partial.errored ?? false,
        variant: name,
      };
    },
  };
}

const buy = (symbol: string, notional_usd: number, rationale = `buy ${symbol}`): TradeDecision => ({
  action: "buy",
  symbol,
  kind: "equity",
  notional_usd,
  confidence: 0.65,
  rationale,
  evidence: [],
});
const sell = (symbol: string, notional_usd: number): TradeDecision => ({
  action: "sell",
  symbol,
  kind: "equity",
  notional_usd,
  confidence: 0.65,
  rationale: `sell ${symbol}`,
  evidence: [],
});
const holdWatch = (watch_symbol: string): TradeDecision => ({
  action: "hold",
  confidence: 0.7,
  rationale: `watch ${watch_symbol}`,
  evidence: [],
  watch_symbol,
  watch_kind: "equity",
});

const OPTS = { benchName: "bench-test", seedCash: 100_000, maxInvestigations: 20, budgetUsd: 10, windowEndMs: WINDOW_END };

// ---------------------------------------------------------------------------

describe("runVariant", () => {
  it("walks events chronologically whatever order they arrive in", async () => {
    const s = scripted("live", {});
    const run = await runVariant(s, [ev("e3", D3), ev("e1", D1), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(s.seen.map((i) => i.item.id)).toEqual(["e1", "e2", "e3"]);
    expect(run.rows.map((r) => r.news_id)).toEqual(["e1", "e2", "e3"]);
    expect(run.investigations).toBe(3);
  });

  it("carries the book across events: the second event sees the first event's position", async () => {
    let positions: unknown = "unset";
    let cash: unknown = "unset";
    const s = scripted("live", {
      e1: { decisions: [buy("ARGT", 10_000)] },
      e2: async (input) => {
        // The portfolio tools behind toolOptions.book, read DURING the second event
        // (the view is live: after the run it would show the window-end mark).
        const view = input.toolOptions!.book as BookView;
        positions = await view.listPositions();
        cash = (await view.getPortfolio())?.cash;
        return {};
      },
    });
    const run = await runVariant(s, [ev("e1", D1), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(run.rows[0].fill).toEqual({ side: "buy", qty: 1000, fillPrice: 10, notionalUsd: 10_000 });
    expect(run.rows[0].dropped).toBeNull();
    // Rendered context the agent reads...
    expect(s.seen[1].bookContext).toContain('"symbol":"ARGT"');
    expect(s.seen[1].bookContext).toContain("Mandate (deployment):");
    // ...and the tools, marked as of the second event (bid 11).
    expect(positions).toEqual([{ symbol: "ARGT", qty: 1000, avg_cost: 10, kind: "equity", last_watch_price: 11 }]);
    expect(cash).toBe(90_000);
    expect(s.seen[1].toolOptions!.asOfMs).toBe(T(D2));
    expect(s.seen[1].nowIso).toBe(D2);
    expect(s.seen[1].bench).toBe(true);
    expect(s.seen[1].transcriptId).toBe("bench/bench-test/live/e2");
  });

  it("a sell beyond what is held opens a short that shows in open_positions", async () => {
    const s = scripted("live", { e3: { decisions: [sell("XYZ", 5_000)] } });
    const run = await runVariant(s, [ev("e3", D3)], OPTS, fakeDeps(table()));
    expect(run.rows[0].fill?.side).toBe("sell");
    const xyz = run.book.open_positions.find((p) => p.symbol === "XYZ");
    expect(xyz).toBeDefined();
    expect(xyz!.qty).toBeLessThan(0);
    // Shorted at the bid (50), marked at the window-end ask (40.1): the short is in profit.
    expect(xyz!.mark).toBe(40.1);
    expect(run.book.final_equity).toBeGreaterThan(100_000);
  });

  it("scores a hold on its watch_symbol as the counterfactual", async () => {
    const s = scripted("live", { e2: { decisions: [holdWatch("SPY")] } });
    const run = await runVariant(s, [ev("e2", D2)], OPTS, fakeDeps(table()));
    const row = run.rows[0];
    expect(row.action).toBe("hold");
    expect(row.symbol).toBe("SPY");
    expect(row.fill).toBeNull();
    expect(row.scoreable).toBe(true);
    // long counterfactual: ask 500.1 at D2 -> bid 505 a day later
    expect(row.ret_1d).toBeCloseTo(505 / 500.1 - 1, 10);
    expect(row.ret_7d).toBeCloseTo(510 / 500.1 - 1, 10);
  });

  it("decisionHistory returns only this run's own prior reasoning", async () => {
    let seenHistory: unknown = "unset";
    let seenUnknown: unknown = "unset";
    const s = scripted("live", {
      e1: { decisions: [buy("ARGT", 10_000, "argentina re-rates")] },
      e2: async (input) => {
        const view = input.toolOptions!.book as BookView;
        seenHistory = await view.decisionHistory("ARGT");
        seenUnknown = await view.decisionHistory("NOPE");
        return { decisions: [holdWatch("ARGT")] };
      },
    });
    await runVariant(s, [ev("e1", D1), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(seenUnknown).toBeNull();
    expect(seenHistory).toMatchObject({
      symbol: "ARGT",
      latest: { action: "buy", confidence: 0.65, rationale: "argentina re-rates", trigger: "test", at: D1 },
      history: [],
    });
  });

  it("two runs never share a book", async () => {
    const a = scripted("a", { e1: { decisions: [buy("ARGT", 10_000)] } });
    const b = scripted("b", {});
    const events = [ev("e1", D1), ev("e2", D2)];
    const runA = await runVariant(a, events, OPTS, fakeDeps(table()));
    const runB = await runVariant(b, events, OPTS, fakeDeps(table()));
    expect(runA.book.open_positions).toHaveLength(1);
    expect(runB.book.open_positions).toHaveLength(0);
    expect(b.seen[0].bookContext).toContain('"positions":[]');
    expect(b.seen[1].bookContext).toContain('"positions":[]');
    expect(runB.book.final_equity).toBe(100_000);
  });

  it("stops at maxInvestigations and says so; later rows carry no action", async () => {
    const s = scripted("live", {});
    const run = await runVariant(s, [ev("e1", D1), ev("e2", D2), ev("e3", D3)], { ...OPTS, maxInvestigations: 1 }, fakeDeps(table()));
    expect(run.investigations).toBe(1);
    expect(run.stopped_reason).toBe("max");
    expect(run.rows.map((r) => r.action)).toEqual(["hold", undefined, undefined]);
    expect(s.seen).toHaveLength(1);
  });

  it("stops when the per-variant budget is spent", async () => {
    const s = scripted("live", {}, 2);
    const deps = fakeDeps(table());
    const run = await runVariant(s, [ev("e1", D1), ev("e2", D2), ev("e3", D3)], { ...OPTS, budgetUsd: 3 }, deps);
    // spent 2 (<3: run), spent 4 (>=3: stop)
    expect(run.investigations).toBe(2);
    expect(run.stopped_reason).toBe("budget");
    expect(run.cost_usd).toBe(4);
    expect(deps.spend).toEqual([2, 2]);
  });

  it("does not count an errored investigation as a decision, but does count its cost", async () => {
    const s = scripted("live", { e1: { errored: true, costUsd: 1.25 } });
    const run = await runVariant(s, [ev("e1", D1), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(run.investigations).toBe(1);
    expect(run.errored).toBe(1);
    expect(run.rows[0].errored).toBe(true);
    expect(run.rows[0].action).toBeUndefined();
    expect(run.rows[0].cost_usd).toBe(1.25);
    expect(run.cost_usd).toBe(1.75);
  });

  it("skips events that failed triage but keeps a row for them", async () => {
    const s = scripted("live", {});
    const run = await runVariant(s, [ev("e1", D1, false), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(s.seen.map((i) => i.item.id)).toEqual(["e2"]);
    expect(run.rows[0]).toMatchObject({ news_id: "e1", materiality: 0.1, cost_usd: 0 });
    expect(run.rows[0].action).toBeUndefined();
  });

  it("marks the book at the window end and reports equity and return on seed", async () => {
    const s = scripted("live", { e1: { decisions: [buy("ARGT", 10_000)] } });
    const run = await runVariant(s, [ev("e1", D1)], OPTS, fakeDeps(table()));
    // 1000 ARGT bought at the ask (10); window-end bid 12 -> 90,000 cash + 12,000
    expect(run.book.seed_cash).toBe(100_000);
    expect(run.book.fills).toBe(1);
    expect(run.book.realized_pnl).toBe(0);
    expect(run.book.final_equity).toBeCloseTo(102_000, 6);
    expect(run.book.return_on_seed).toBeCloseTo(0.02, 10);
    expect(run.book.open_positions).toEqual([{ symbol: "ARGT", kind: "equity", qty: 1000, avg_cost: 10, mark: 12 }]);
  });

  it("records a dropped primary action with the sim book's reason and audits every decision", async () => {
    const s = scripted("live", { e1: { decisions: [buy("ARGT", 1_000_000)] } });
    const deps = fakeDeps(table());
    const run = await runVariant(s, [ev("e1", D1)], OPTS, deps);
    expect(run.rows[0].fill).toBeNull();
    expect(run.rows[0].dropped).toBe("insufficient_cash");
    expect(run.book.fills).toBe(0);
    expect(deps.audits).toHaveLength(1);
    expect(deps.audits[0]).toMatchObject({ variant: "live", errored: false, headline: "headline e1" });
  });

  it("drops an action whose symbol has no as-of price as unresolvable", async () => {
    const s = scripted("live", { e1: { decisions: [buy("GHOST", 1_000)] } });
    const run = await runVariant(s, [ev("e1", D1)], OPTS, fakeDeps(table()));
    expect(run.rows[0].dropped).toBe("unresolvable");
    expect(run.rows[0].scoreable).toBe(false);
    expect(run.rows[0].ret_1d).toBeNull();
  });

  it("hands later events the watchlist of instruments earlier holds named", async () => {
    const s = scripted("live", { e1: { decisions: [holdWatch("SPY")] } });
    await runVariant(s, [ev("e1", D1), ev("e2", D2)], OPTS, fakeDeps(table()));
    expect(s.seen[0].bookContext).not.toContain("SPY");
    expect(s.seen[1].bookContext).toContain("SPY");
  });
});

describe("watchlistFrom", () => {
  const adj = (atMs: number, decisions: TradeDecision[]) => ({ atMs, headline: "h", decisions });

  it("keeps holds' watch symbols inside the window, newest first, one per symbol", () => {
    const now = T(D3);
    const list = watchlistFrom(
      [
        adj(T(D1), [holdWatch("SPY")]),
        adj(T(D2), [holdWatch("SPY"), holdWatch("QQQ"), buy("ARGT", 1)]),
      ],
      now,
      72 * 3_600_000,
    );
    expect(list.map((w) => w.symbol)).toEqual(["SPY", "QQQ"]);
    expect(list[0].at).toBe(D2);
    expect(list[0].confidence).toBe(0.7);
  });

  it("drops entries older than the window and ignores trades", () => {
    const list = watchlistFrom([adj(T(D1), [holdWatch("SPY")]), adj(T(D3), [buy("ARGT", 1)])], T(D3), 24 * 3_600_000);
    expect(list).toEqual([]);
  });
});

describe("simBookView", () => {
  it("compacts theses like thesis.ts: latest 600 chars, history 200 chars, at most 8 history entries", async () => {
    const theses = new Map();
    const long = "x".repeat(1000);
    for (let i = 0; i < 12; i++) {
      pushThesis(theses, "ARGT", { at: `t${i}`, action: "hold", confidence: 0.5, trigger: "test", rationale: long });
    }
    const view = simBookView(new SimBook({ cash: 1, nowMs: T(D1) }), theses);
    const t = (await view.decisionHistory("ARGT")) as { latest: { at: string; rationale: string }; history: { rationale: string }[] };
    expect(t.latest.at).toBe("t11");
    expect(t.latest.rationale).toHaveLength(600);
    expect(t.history).toHaveLength(8);
    expect(t.history[0].rationale).toHaveLength(200);
  });

  it("exposes recent trades newest first, capped", async () => {
    const book = new SimBook({ cash: 100_000, nowMs: T(D1) });
    const q = (asOfMs: number, bid: number, ask: number) => ({ symbol: "ARGT", kind: "equity" as const, price: (bid + ask) / 2, bid, ask, asOfMs, source: "fake" });
    book.apply(buy("ARGT", 1000) as TradeDecision & { action: "buy" }, q(T(D1), 9.9, 10), "d1");
    book.setClock(T(D2));
    book.apply(buy("ARGT", 1000) as TradeDecision & { action: "buy" }, q(T(D2), 11, 11.1), "d2");
    const view = simBookView(book, new Map());
    const trades = (await view.recentTrades("ARGT", 1)) as { decisionId: string; filledAt: string }[];
    expect(trades).toHaveLength(1);
    expect(trades[0].decisionId).toBe("d2");
    expect(trades[0].filledAt).toBe(D2);
    expect(await view.recentTrades("SPY", 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Parking: an order that is stale at event time (venue closed) fills at the
// first fillable moment before the book moves on, as the live watcher does.
// ---------------------------------------------------------------------------

function scriptedCtx(byId: Record<string, TradeDecision[]>, name = "scripted"): Strategy & { contexts: string[] } {
  const contexts: string[] = [];
  return {
    name,
    description: "scripted",
    contexts,
    async decide(input: StrategyInput): Promise<StrategyResult> {
      contexts.push(input.bookContext ?? "");
      const decisions = byId[input.item.id] ?? [{ action: "hold", confidence: 0.5, rationale: "r", evidence: [] }];
      return { variant: name, decisions, costUsd: 0.1, numTurns: 1, degraded: true, transcriptUri: null, finalText: "", errored: false };
    },
  };
}

const buyNite: TradeDecision = { action: "buy", symbol: "NITE", kind: "equity", notional_usd: 1000, confidence: 0.7, rationale: "r", evidence: [] };
const runOpts = { benchName: "t", seedCash: 100_000, maxInvestigations: 10, budgetUsd: 10, windowEndMs: WINDOW_END };

describe("runVariant parking", () => {
  it("parks a stale-at-event order and fills it at the first fillable moment, before the next event", async () => {
    const fillAt = T(D1) + 2 * 3_600_000;
    const prices: Table = { NITE: [{ tMs: T(D1) - 5 * 3_600_000, bid: 9, ask: 9.1 }, { tMs: fillAt, bid: 10, ask: 10.1 }] };
    const strat = scriptedCtx({ e1: [buyNite] });
    const run = await runVariant(strat, [ev("e1", D1), ev("e2", D2)], runOpts, fakeDeps(prices));
    const r1 = run.rows.find((r) => r.news_id === "e1")!;
    expect(r1.parked_until).toBe(new Date(fillAt).toISOString());
    expect(r1.filled_at).toBe(new Date(fillAt).toISOString());
    expect(r1.dropped).toBeNull();
    expect(r1.fill).toMatchObject({ side: "buy", fillPrice: 10.1 });
    expect(run.book.fills).toBe(1);
    expect(run.parked).toBe(0);
    // The second event was decided with NITE already in the book.
    expect(strat.contexts[1]).toContain("NITE");
  });

  it("expires an order with no fillable quote within the pending window", async () => {
    const prices: Table = { NITE: [{ tMs: T(D1) - 5 * 3_600_000, bid: 9, ask: 9.1 }] };
    const run = await runVariant(scriptedCtx({ e1: [buyNite] }), [ev("e1", D1), ev("e2", D2)], runOpts, fakeDeps(prices));
    const r1 = run.rows.find((r) => r.news_id === "e1")!;
    expect(r1.dropped).toBe("expired_pending");
    expect(r1.fill).toBeNull();
    expect(run.book.fills).toBe(0);
  });

  it("treats a historical bar's span as granularity, not staleness", async () => {
    const prices: Table = { NITE: [{ tMs: T(D1) - 50 * 60_000, bid: 9, ask: 9.1 }] }; // 50 min old
    const base = fakeDeps(prices);
    const deps: RunDeps = {
      ...base,
      resolveAsOf: async (s, k, ms) => {
        const r = await base.resolveAsOf(s, k, ms);
        return r.ok ? { ...r, meta: { ...r.meta, barSpanSecs: 3600 } } : r; // an hourly bar
      },
    };
    const run = await runVariant(scriptedCtx({ e1: [buyNite] }), [ev("e1", D1)], runOpts, deps);
    const r1 = run.rows[0];
    expect(r1.parked_until).toBeNull();
    expect(r1.fill).toMatchObject({ side: "buy" });
    // Without the span the same quote is stale and parks (no later tick: expires).
    const strict = await runVariant(scriptedCtx({ e1: [buyNite] }), [ev("e1", D1)], runOpts, base);
    expect(strict.rows[0].dropped).toBe("expired_pending");
  });
});


// ---------------------------------------------------------------------------
// Working exits: a liquidity-capped REDUCTION keeps slicing the book, one paced
// slice at a time, until the position is gone; an opening fill is capped once.
// ---------------------------------------------------------------------------

describe("runVariant working exits", () => {
  const sliceMs = config.pendingSliceMinutes * 60_000;
  const buyX: TradeDecision = { action: "buy", symbol: "X", kind: "equity", notional_usd: 1000, confidence: 0.7, rationale: "r", evidence: [] };
  const sellX: TradeDecision = { ...buyX, action: "sell" };

  it("a capped reduction keeps working the book in paced slices until the position is gone", async () => {
    const ticks: Tick[] = [{ tMs: T(D1), bid: 10, ask: 10, liq: 100_000 }];
    for (let k = 0; k <= 12; k++) ticks.push({ tMs: T(D2) + k * sliceMs, bid: 10, ask: 10, liq: 400 });
    const run = await runVariant(scriptedCtx({ e1: [buyX], e2: [sellX] }), [ev("e1", D1), ev("e2", D2), ev("e3", D3)], runOpts, fakeDeps({ X: ticks }));
    const r2 = run.rows.find((r) => r.news_id === "e2")!;
    // $1,000 asked; each slice takes 25% of a $400 book = $100 = 10 shares: the
    // first at the event, nine more one per hour, then the position is closed.
    expect(r2.fill).toMatchObject({ side: "sell", qty: 100, fillPrice: 10 });
    expect(r2.fill!.notionalUsd).toBeCloseTo(1000);
    expect(r2.slices).toBe(9);
    expect(r2.dropped).toBeNull();
    expect(r2.filled_at).toBe(new Date(T(D2) + 9 * sliceMs).toISOString());
    expect(run.book.open_positions).toEqual([]);
    expect(run.book.fills).toBe(11);
    expect(run.parked).toBe(0);
  });

  it("an opening fill is capped once and not sliced", async () => {
    const prices: Table = { X: [{ tMs: T(D1), bid: 10, ask: 10, liq: 400 }, { tMs: T(D1) + sliceMs, bid: 10, ask: 10, liq: 400 }] };
    const run = await runVariant(scriptedCtx({ e1: [buyX] }), [ev("e1", D1), ev("e2", D2)], runOpts, fakeDeps(prices));
    const r1 = run.rows.find((r) => r.news_id === "e1")!;
    expect(r1.fill!.notionalUsd).toBeCloseTo(100);
    expect(r1.slices).toBeUndefined();
    expect(run.book.fills).toBe(1);
    expect(run.parked).toBe(0);
  });

  it("a working exit stops when a later decision closes the position first", async () => {
    // e2 sells $1,000 into a $400 book (slice 1: 10 sh), then e2b (30 min later) sells the rest outright in a deep book.
    const D2b = new Date(T(D2) + 30 * 60_000).toISOString();
    const ticks: Tick[] = [
      { tMs: T(D1), bid: 10, ask: 10, liq: 100_000 },
      { tMs: T(D2), bid: 10, ask: 10, liq: 400 },
      { tMs: T(D2b), bid: 10, ask: 10, liq: 100_000 },
      { tMs: T(D2) + sliceMs, bid: 10, ask: 10, liq: 400 },
    ];
    const run = await runVariant(
      scriptedCtx({ e1: [buyX], e2: [sellX], e2b: [{ ...sellX, notional_usd: 900 }] }),
      [ev("e1", D1), ev("e2", D2), ev("e2b", D2b), ev("e3", D3)],
      runOpts,
      fakeDeps({ X: ticks }),
    );
    // The fresh decision on X superseded the working remainder (live: cancelPending); nothing is left to slice.
    expect(run.rows.find((r) => r.news_id === "e2b")!.fill).toMatchObject({ qty: 90 });
    expect(run.rows.find((r) => r.news_id === "e2")!.slices).toBeUndefined();
    expect(run.book.open_positions).toEqual([]);
    expect(run.book.fills).toBe(3);
    expect(run.parked).toBe(0);
  });
});
