// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { compactEntry, type ThesisEntry } from "../src/thesis.js";

describe("compactEntry", () => {
  const entry: ThesisEntry = {
    at: "2026-08-31T12:00:00Z",
    action: "buy",
    confidence: 0.6,
    trigger: "macro",
    rationale: "x".repeat(1000),
  };
  it("truncates the rationale to the given max", () => {
    expect(compactEntry(entry, 600).rationale.length).toBe(600);
    expect(compactEntry(entry, 200).rationale.length).toBe(200);
  });
  it("preserves the other fields", () => {
    const c = compactEntry(entry, 100);
    expect(c.action).toBe("buy");
    expect(c.confidence).toBe(0.6);
    expect(c.trigger).toBe("macro");
    expect(c.at).toBe(entry.at);
  });
});
