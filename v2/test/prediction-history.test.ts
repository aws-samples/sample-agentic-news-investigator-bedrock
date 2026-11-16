// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { closedBy } from "../src/quotes/prediction-history.js";

describe("prediction history: no price after close", () => {
  it("parses Polymarket and Kalshi stamps and refuses at/after the earliest", () => {
    const sep28 = Date.parse("2026-09-28T14:00:00Z");
    const sep04 = Date.parse("2026-09-04T14:00:00Z");
    expect(closedBy(sep28, "2026-09-16 20:02:27+00", "2026-09-16T20:02:27Z")).toBe(true);
    expect(closedBy(sep04, "2026-09-16 20:02:27+00", "2026-09-16T20:02:27Z")).toBe(false);
    expect(closedBy(sep28, "2026-09-16T17:59:00Z", "2026-09-16T18:08:08.647338Z")).toBe(true);
    expect(closedBy(sep04, null, undefined, "")).toBe(false);
  });
});
