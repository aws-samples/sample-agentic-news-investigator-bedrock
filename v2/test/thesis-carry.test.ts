// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { carryExitPlan, type ThesisEntry } from "../src/thesis.js";

describe("v6 exit plan survives re-checks", () => {
  it("a hold inherits the opening trade's plan", () => {
    const buy: ThesisEntry = { at: "2026-10-22T06:02:00Z", action: "buy", confidence: 0.7, trigger: "sweep", rationale: "r", fair_probability: 0.8, exit_target: 0.84, exit_stop: 0.62, exit_by: "2026-10-23T18:00:00Z" };
    const hold: ThesisEntry = { at: "2026-10-22T09:00:00Z", action: "hold", confidence: 0.7, trigger: "position-watch", rationale: "still fine" };
    expect(carryExitPlan(hold, buy)).toMatchObject({ action: "hold", rationale: "still fine", exit_by: "2026-10-23T18:00:00Z", exit_stop: 0.62, fair_probability: 0.8 });
  });
});
