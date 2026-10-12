// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { runDecisions } from "../src/run-decisions.js";
import type { TradeDecision } from "../src/types.js";

const buy: TradeDecision = {
  action: "buy",
  symbol: "SPY",
  notional_usd: 1000,
  confidence: 0.7,
  rationale: "r",
  evidence: [],
} as TradeDecision;

describe("runDecisions", () => {
  it("passes a clean run's decisions through", () => {
    const r = runDecisions({ submitted: [buy], errored: false, guardrailIntervened: false, maxTurns: 20 });
    expect(r.decisions).toEqual([buy]);
    expect(r.withheld).toEqual([]);
  });

  it("holds when nothing was submitted", () => {
    const r = runDecisions({ submitted: [], errored: false, guardrailIntervened: false, maxTurns: 20 });
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]).toMatchObject({ action: "hold", confidence: 0 });
    expect(r.decisions[0].rationale).toContain("maxTurns=20");
    expect(r.withheld).toEqual([]);
  });

  it("withholds decisions submitted before the run errored", () => {
    const r = runDecisions({ submitted: [buy], errored: true, guardrailIntervened: false, maxTurns: 20 });
    expect(r.decisions).toEqual([expect.objectContaining({ action: "hold", confidence: 0 })]);
    expect(r.decisions[0].rationale).toContain("errored after 1 submit_decision");
    expect(r.withheld).toEqual([buy]);
  });

  it("withholds decisions submitted before the guardrail intervened", () => {
    const r = runDecisions({
      submitted: [buy, { ...buy, symbol: "QQQ" }],
      errored: false,
      guardrailIntervened: true,
      blockedSide: "output",
      maxTurns: 20,
    });
    expect(r.decisions).toEqual([expect.objectContaining({ action: "hold" })]);
    expect(r.decisions[0].rationale).toContain("guardrail blocked the investigation (output)");
    expect(r.withheld).toHaveLength(2);
  });
});
