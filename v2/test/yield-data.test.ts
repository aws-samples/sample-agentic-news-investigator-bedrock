// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  aggregateYield,
  admitForYield,
  categoryOf,
  decayWeight,
  renderYieldTable,
  thresholdFor,
  type YieldDecisionRow,
  type YieldParams,
  type YieldTable,
} from "../src/yield-data.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-19T12:00:00Z");
const P: YieldParams = { nowMs: NOW, halfLifeDays: 7, minN: 20, maturityDays: 8, baseThreshold: 0.45, maxShift: 0.2, floor: 0.3, ceil: 0.8 };
const params = { halfLifeDays: 7, minN: 20, maturityDays: 8, baseThreshold: 0.45, maxShift: 0.2, floor: 0.3, ceil: 0.8 };

describe("categoryOf", () => {
  it("pairs the poller family with the first triage event type, and drops the type for internal triggers", () => {
    expect(categoryOf("edgar", "corporate")).toBe("edgar|corporate");
    expect(categoryOf("crypto", "macro|political")).toBe("crypto|macro");
    expect(categoryOf("Macro", " Macro ")).toBe("macro|macro");
    expect(categoryOf("position-watch", "corporate")).toBe("position-watch|-");
    expect(categoryOf("daily-review", undefined)).toBe("daily-review|-");
    expect(categoryOf(undefined, undefined)).toBe("?|?");
    expect(categoryOf("edgar", "")).toBe("edgar|?");
  });
});

describe("decayWeight and thresholdFor", () => {
  it("halves every half-life and never exceeds 1", () => {
    expect(decayWeight(NOW, NOW, 7)).toBe(1);
    expect(decayWeight(NOW - 7 * DAY, NOW, 7)).toBeCloseTo(0.5, 9);
    expect(decayWeight(NOW + DAY, NOW, 7)).toBe(1);
    expect(decayWeight(NOW - 70 * DAY, NOW, 0)).toBe(1);
  });

  it("maps yield to a bar: base+shift at or below zero, base at the global yield, base−shift at twice it, clamped", () => {
    expect(thresholdFor(-1, 10, params)).toBeCloseTo(0.65, 9);
    expect(thresholdFor(0, 10, params)).toBeCloseTo(0.65, 9);
    expect(thresholdFor(10, 10, params)).toBeCloseTo(0.45, 9);
    expect(thresholdFor(20, 10, params)).toBeCloseTo(0.25 < 0.3 ? 0.3 : 0.25, 9); // floor clamps
    expect(thresholdFor(15, 10, params)).toBeCloseTo(0.35, 9);
    expect(thresholdFor(null, 10, params)).toBe(0.45);
    expect(thresholdFor(5, null, params)).toBe(0.45);
    expect(thresholdFor(5, -2, params)).toBe(0.45); // nothing has information when the global yield is not positive
    expect(thresholdFor(-3, 10, { ...params, ceil: 0.6 })).toBe(0.6);
  });
});

function decision(over: Partial<YieldDecisionRow> & { newsId: string }): YieldDecisionRow {
  return { trigger: "edgar", costUsd: 1, atMs: NOW - 10 * DAY, actions: [], ...over };
}

describe("aggregateYield", () => {
  const triage = [
    { newsId: "e1", trigger: "?", eventType: "corporate", materiality: 0.6, atMs: NOW - 10 * DAY },
    { newsId: "e2", trigger: "?", eventType: "corporate", materiality: 0.7, atMs: NOW - 9 * DAY },
    { newsId: "e3", trigger: "?", eventType: "corporate", materiality: 0.5, atMs: NOW - 2 * DAY },
    { newsId: "d1", trigger: "?", eventType: "disaster", materiality: 0.8, atMs: NOW - 10 * DAY },
    { newsId: "d2", trigger: "?", eventType: "disaster", materiality: 0.7, atMs: NOW - 10 * DAY },
  ];
  const decisions: YieldDecisionRow[] = [
    // matured, one buy that made money (single action → actionId = news id)
    decision({ newsId: "e1", costUsd: 2, actions: [{ action: "buy", symbol: "AAA", notionalUsd: 1000, actionId: "e1" }] }),
    // matured, two actions (ids #1, #2): a losing sell and a hold
    decision({ newsId: "e2", costUsd: 2, atMs: NOW - 9 * DAY, actions: [{ action: "sell", symbol: "BBB", notionalUsd: 500, actionId: "e2#1" }, { action: "hold", symbol: null, notionalUsd: null, actionId: "e2#2" }] }),
    // too young to have a 7-day score: cost counts in the raw totals, not in the yield
    decision({ newsId: "e3", costUsd: 5, atMs: NOW - 2 * DAY, actions: [{ action: "buy", symbol: "CCC", notionalUsd: 1000, actionId: "e3" }] }),
    // disasters: matured, no trades
    decision({ newsId: "d1", trigger: "disaster", costUsd: 0.4, actions: [{ action: "hold", symbol: null, notionalUsd: null, actionId: "d1" }] }),
    decision({ newsId: "d2", trigger: "disaster", costUsd: 0.4, actions: [] }),
    // internal trigger, no triage row
    decision({ newsId: "w1", trigger: "position-watch", costUsd: 1, actions: [{ action: "hold", symbol: "AAA", notionalUsd: null, actionId: "w1" }] }),
  ];
  const scores = [
    { actionId: "e1", symbol: "AAA", action: "buy", ret7d: 0.1 },
    { actionId: "e2#1", symbol: "BBB", action: "sell", ret7d: -0.04 },
    { actionId: "e3", symbol: "CCC", action: "buy", ret7d: null },
  ];
  const orders = [{ decisionId: "e1", notionalUsd: 800 }]; // filled less than requested (liquidity cap)
  const t = aggregateYield({ triage, decisions, scores, orders }, P);
  const by = Object.fromEntries(t.categories.map((c) => [c.category, c]));

  it("groups by trigger and triage event type, counting raw cost and actions for every decision", () => {
    expect(Object.keys(by).sort()).toEqual(["disaster|disaster", "edgar|corporate", "position-watch|-"]);
    expect(by["edgar|corporate"].n).toBe(3);
    expect(by["edgar|corporate"].costUsd).toBeCloseTo(9, 9);
    expect(by["edgar|corporate"].actions).toBe(3); // buy, sell, buy (holds excluded)
    expect(by["edgar|corporate"].medianMateriality).toBe(0.6);
  });

  it("uses filled notional when an order exists, requested notional otherwise, and only matured decisions", () => {
    const e = by["edgar|corporate"];
    expect(e.nMatured).toBe(2); // e3 is 2 days old
    expect(e.scored).toBe(2);
    expect(e.hit7d).toBe(50);
    const w1 = decayWeight(NOW - 10 * DAY, NOW, 7);
    const w2 = decayWeight(NOW - 9 * DAY, NOW, 7);
    expect(e.pnlEff).toBeCloseTo(w1 * 800 * 0.1 + w2 * 500 * -0.04, 6);
    expect(e.costEff).toBeCloseTo(w1 * 2 + w2 * 2, 6);
    expect(e.yieldRaw).toBeCloseTo(e.pnlEff / e.costEff, 9);
  });

  it("shrinks small categories toward the global yield and turns yield into a bar", () => {
    const g = t.global.yield!;
    expect(g).toBeGreaterThan(0);
    const e = by["edgar|corporate"];
    expect(e.yieldShrunk).toBeCloseTo((e.nEff * e.yieldRaw! + 20 * g) / (e.nEff + 20), 9);
    const d = by["disaster|disaster"];
    expect(d.yieldRaw).toBe(0);
    expect(d.yieldShrunk!).toBeLessThan(g); // pulled down from the global by its own zero
    expect(d.yieldShrunk!).toBeGreaterThan(0); // but not to zero: two data points cannot swing the bar
    expect(d.threshold).toBeGreaterThan(0.45);
    expect(d.threshold).toBeLessThanOrEqual(0.65);
    expect(e.threshold).toBeLessThan(d.threshold);
    expect(by["position-watch|-"].yieldRaw).toBe(0);
  });

  it("bounds a single trade's 7-day return at ±100% so one prediction contract cannot set a bar", () => {
    const wild = aggregateYield(
      {
        triage: [],
        decisions: [decision({ newsId: "p1", trigger: "crypto", costUsd: 1, actions: [{ action: "buy", symbol: "x:NO", notionalUsd: 100, actionId: "p1" }] })],
        scores: [{ actionId: "p1", symbol: "x:NO", action: "buy", ret7d: 19 }],
        orders: [],
      },
      P,
    );
    const c = wild.categories[0];
    expect(c.pnlEff).toBeCloseTo(decayWeight(NOW - 10 * DAY, NOW, 7) * 100 * 1, 6);
  });

  it("renders every category", () => {
    const txt = renderYieldTable(t);
    expect(txt).toContain("edgar|corporate");
    expect(txt).toContain("disaster|disaster");
    expect(txt).toContain("global yield");
  });
});

describe("admitForYield", () => {
  const table: YieldTable = {
    computedAtIso: "2026-09-19T00:00:00Z",
    params,
    global: { n: 100, costUsd: 500, costEff: 300, pnlEff: 1500, yield: 5 },
    categories: [
      { category: "disaster|disaster", n: 200, actions: 4, costUsd: 64, nMatured: 150, nEff: 90, costEff: 40, pnlEff: 0, scored: 2, hit7d: 50, yieldRaw: 0, yieldShrunk: 0.9, threshold: 0.65, medianMateriality: 0.72 },
      { category: "macro|macro", n: 46, actions: 15, costUsd: 41, nMatured: 40, nEff: 25, costEff: 20, pnlEff: 700, scored: 6, hit7d: 67, yieldRaw: 35, yieldShrunk: 16, threshold: 0.3, medianMateriality: 0.62 },
    ],
  };
  const cfg = { triageThreshold: 0.45, heldTriageThreshold: 0.35, explorationPerDay: 3 };

  it("applies the category bar for ordinary news", () => {
    const rejected = admitForYield({ materiality: 0.6, touches_positions: false, event_type: "disaster" }, "disaster", table, 3, cfg);
    expect(rejected.admitted).toBe(false);
    expect(rejected.threshold).toBe(0.65);
    expect(rejected.baseThreshold).toBe(0.45);
    expect(rejected.reason).toContain("disaster|disaster: 0.60 < 0.65");
    const admitted = admitForYield({ materiality: 0.32, touches_positions: false, event_type: "macro" }, "macro", table, 0, cfg);
    expect(admitted.admitted).toBe(true);
    expect(admitted.threshold).toBe(0.3);
    expect(admitted.yieldPerDollar).toBe(16);
  });

  it("keeps the held bar for news touching a position, whatever the yield", () => {
    const a = admitForYield({ materiality: 0.4, touches_positions: true, event_type: "disaster" }, "disaster", table, 3, cfg);
    expect(a.admitted).toBe(true);
    expect(a.threshold).toBe(0.35);
    expect(a.explored).toBe(false);
  });

  it("explores: admits a sub-bar item at the base bar until the daily floor is used up", () => {
    const first = admitForYield({ measure: 0, materiality: 0.5, touches_positions: false, event_type: "disaster" } as any, "disaster", table, 0, cfg);
    expect(first.admitted).toBe(true);
    expect(first.explored).toBe(true);
    expect(first.threshold).toBe(0.45);
    expect(first.reason).toContain("exploring");
    const exhausted = admitForYield({ materiality: 0.5, touches_positions: false, event_type: "disaster" }, "disaster", table, 3, cfg);
    expect(exhausted.admitted).toBe(false);
    const belowBase = admitForYield({ materiality: 0.4, touches_positions: false, event_type: "disaster" }, "disaster", table, 0, cfg);
    expect(belowBase.admitted).toBe(false); // exploration never lowers the bar below the base
  });

  it("falls back to the flat bars without a table or for an unknown category", () => {
    const noTable = admitForYield({ materiality: 0.46, touches_positions: false, event_type: "disaster" }, "disaster", null, 0, cfg);
    expect(noTable.admitted).toBe(true);
    expect(noTable.threshold).toBe(0.45);
    expect(noTable.yieldPerDollar).toBeNull();
    const unknown = admitForYield({ materiality: 0.44, touches_positions: false, event_type: "regulatory" }, "crypto", table, 0, cfg);
    expect(unknown.admitted).toBe(false);
    expect(unknown.category).toBe("crypto|regulatory");
    expect(unknown.threshold).toBe(0.45);
  });
});
