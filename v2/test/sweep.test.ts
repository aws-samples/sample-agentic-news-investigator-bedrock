// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { freshNews } from "../src/sweep.js";

describe("sweep headlines", () => {
  // 2026-10-23 → 10-25: with no new material item to trigger a trim, three Oct 23 headlines
  // rode ~25 sweeps labelled "in the last 8h".
  it("drops headlines older than the window at sweep time, not only when news arrives", () => {
    const now = Date.parse("2026-10-25T21:51:00Z");
    const items = [
      { at: "2026-10-23T13:45:00Z", headline: "US services PMI" },
      { at: "2026-10-23T20:05:00Z", headline: "oil wrap" },
      { at: "2026-10-25T14:00:00Z", headline: "inside the window" },
    ];
    expect(freshNews(items, now).map((n) => n.headline)).toEqual(["inside the window"]);
    expect(freshNews(items.slice(0, 2), Date.parse("2026-10-23T21:00:00Z")).length).toBe(2);
    expect(freshNews([], now)).toEqual([]);
  });
});
