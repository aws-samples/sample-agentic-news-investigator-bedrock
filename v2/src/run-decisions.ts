// SPDX-License-Identifier: MIT-0
import type { TradeDecision } from "./types.js";

/**
 * What an investigation run is allowed to act on. Pure, so it is unit-tested
 * without the Agent SDK.
 *
 * A run that errored or that the Bedrock guardrail intervened in is not a
 * finished judgment: its earlier `submit_decision` calls were made before the
 * failure, possibly on the very content the guardrail later blocked. Those
 * decisions are withheld (kept for the audit row, never executed) and the run
 * acts on a single zero-confidence hold, the same default as a run that never
 * submitted. Until 2026-10-07 an errored or guardrail-intervened
 * run still executed whatever it had submitted.
 */
export function runDecisions(opts: {
  submitted: TradeDecision[];
  errored: boolean;
  guardrailIntervened: boolean;
  /** Where the guardrail blocked ("input" | "output"), when known. */
  blockedSide?: string | null;
  maxTurns: number;
}): { decisions: TradeDecision[]; withheld: TradeDecision[] } {
  const { submitted, errored, guardrailIntervened, maxTurns } = opts;
  const failed = errored || guardrailIntervened;
  if (submitted.length > 0 && !failed) return { decisions: submitted, withheld: [] };
  const where = opts.blockedSide ?? "mid-run";
  const why = guardrailIntervened
    ? `the Bedrock guardrail blocked the investigation (${where})`
    : errored
      ? "the investigation errored"
      : `no submit_decision call before the loop ended (maxTurns=${maxTurns})`;
  const rationale =
    submitted.length > 0
      ? `${why} after ${submitted.length} submit_decision call(s); those are withheld and the run holds`
      : `${why} before any submit_decision; defaulting to hold`;
  return {
    decisions: [{ action: "hold", confidence: 0, rationale, evidence: [] }],
    withheld: failed ? submitted : [],
  };
}
