// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { investigatorSystem, fastDeskSection, TRIAGE_SYSTEM, TRIAGE_SYSTEM_PREDICTION } from "../src/prompts.js";
import { renderMandate } from "../src/mandate.js";
import { config } from "../src/config.js";

// The arms share one prompt builder; v5/v6 branches must never leak into the controls.
const v2 = investigatorSystem({ dryRun: false });
const v3 = investigatorSystem({ dryRun: false, worldModel: true });
const v5 = investigatorSystem({ dryRun: false, universe: "prediction", futuresMaxPct: 0.2 });
const v6 = investigatorSystem({ dryRun: false, universe: "prediction", futuresMaxPct: 0.2, fastDesk: true });

describe("investigator prompt per arm", () => {
  it("v2/v3/v5 carry none of the v6 fast-reaction package", () => {
    for (const p of [v2, v3, v5]) {
      expect(p).not.toContain("Fast reaction");
      expect(p).not.toContain("quarter-Kelly");
    }
  });
  it("v2 keeps its 1–7 day horizon and anything-with-a-quote universe", () => {
    expect(v2).toContain("next 1–7 days");
    expect(v2).toContain("## The universe");
    expect(v2).not.toContain("## The desk");
  });
  it("v5 is the desk with the conviction ladder", () => {
    expect(v5).toContain("## The desk: prediction markets");
    expect(v5).toContain("10–15%");
    expect(v5).toContain("search_kalshi");
  });
  it("v6 adds the fast section, a 24 h horizon and edge sizing", () => {
    expect(v6).toContain(fastDeskSection());
    expect(v6).toContain("next 24 hours");
    expect(v6).toContain("stake ≈ 0.25 × (p − c) / (1 − c)");
    expect(v6).not.toContain("next 1–7 days");
  });
});

describe("prediction triage", () => {
  it("screens filings out unless a contract names the company", () => {
    expect(TRIAGE_SYSTEM_PREDICTION).toContain("Corporate filings are rarely material here: score < 0.2");
    expect(TRIAGE_SYSTEM_PREDICTION).not.toBe(TRIAGE_SYSTEM);
  });
});

describe("mandate ladder", () => {
  const util = { equityUsd: 100_000, deployedUsd: 10_000, deployedPct: 0.1, positions: 2 };
  it("v5 (prediction, not fast) shows the conviction ladder", () => {
    // renderMandate's fast branch reads config.fastDesk; only the v5 branch is safe to test here.
    if (config.fastDesk) return;
    const m = renderMandate(util, [], config.mandate, new Date("2026-10-21T12:00:00Z"), "prediction");
    expect(m).toContain("0.80+ ≈ 10–15%");
    expect(m).toContain("per theme");
    expect(m).not.toContain("Edge → size");
  });
  it("v2 (all) keeps the original ladder", () => {
    const m = renderMandate(util, [], config.mandate, new Date("2026-10-21T12:00:00Z"), "all");
    expect(m).toContain("0.55 ≈ 1%");
  });
});
