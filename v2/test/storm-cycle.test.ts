// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { StormCycleBuffer, triageRank } from "../src/storm-cycle.js";
import type { NewsItem } from "../src/types.js";

const item = (id: string, headline: string, source_family = "disaster"): NewsItem =>
  ({ id, headline, source_family, source_id: "nhc", published_at: "2026-10-24T02:45:00Z", ingested_at: "", summary: "", url: "", tickers_hint: [] }) as NewsItem;

describe("storm cycles are triaged by their most informative product", () => {
  it("ranks prose above the coded advisory", () => {
    expect(triageRank("Hurricane Vance Forecast Discussion Number 11")).toBeGreaterThan(triageRank("Hurricane Vance Public Advisory Number 11"));
    expect(triageRank("Hurricane Vance Public Advisory Number 11")).toBeGreaterThan(triageRank("Summary for Hurricane Vance (EP2/EP222026)"));
    expect(triageRank("Summary for Hurricane Vance (EP2/EP222026)")).toBeGreaterThan(triageRank("Hurricane Vance Forecast Advisory Number 11"));
    expect(triageRank("Hurricane Vance Forecast Advisory Number 11")).toBeGreaterThan(triageRank("Hurricane Vance Graphics"));
  });

  it("v6's cycle 11, in its real arrival order: the coded advisory first no longer stands for the cycle", () => {
    const b = new StormCycleBuffer(90_000);
    const t = Date.parse("2026-10-24T02:46:52Z");
    expect(b.offer(item("fa", "Hurricane Vance Forecast Advisory Number 11"), t)).toBe("held");
    expect(b.offer(item("wsp", "Hurricane Vance Wind Speed Probabilities Number 11"), t)).toBe("held");
    expect(b.offer(item("pa", "Hurricane Vance Public Advisory Number 11"), t + 3_000)).toBe("held");
    expect(b.offer(item("sum", "Summary for Hurricane Vance (EP2/EP222026)"), t + 3_000)).toBe("held");
    expect(b.offer(item("fd", "Hurricane Vance Forecast Discussion Number 11"), t + 57_000)).toBe("held");
    expect(b.due(t + 89_999)).toEqual([]);
    const [c, ...rest] = b.due(t + 90_000);
    expect(rest).toEqual([]);
    expect(c.best.id).toBe("fd");
    expect(c.passedOver.map((i) => i.id).sort()).toEqual(["fa", "pa", "sum", "wsp"]);
    expect(b.due(t + 200_000)).toEqual([]);
  });

  it("an undated Summary that arrives first joins the numbered cycle instead of opening a second one", () => {
    const b = new StormCycleBuffer(60_000);
    b.offer(item("sum", "Summary for Hurricane Vance (EP2/EP222026)"), 0);
    b.offer(item("pa", "Hurricane Vance Public Advisory Number 11"), 1_000);
    b.offer(item("gr", "Hurricane Vance Graphics"), 2_000);
    const out = b.due(60_000);
    expect(out).toHaveLength(1);
    expect(out[0].best.id).toBe("pa");
  });

  it("separate storms and separate cycles stay separate; non-storm news and a zero window pass straight through", () => {
    const b = new StormCycleBuffer(60_000);
    b.offer(item("v11", "Hurricane Vance Public Advisory Number 11"), 0);
    b.offer(item("v12", "Hurricane Vance Public Advisory Number 12"), 0);
    b.offer(item("w3", "Tropical Storm Wilfred Public Advisory Number 3"), 0);
    expect(b.due(60_000).map((c) => c.best.id).sort()).toEqual(["v11", "v12", "w3"]);
    expect(b.offer(item("x", "RBNZ expected to hike", "macro"), 0)).toBe("pass");
    expect(b.offer(item("y", "Karina forces Salina Cruz refinery shutdown", "news"), 0)).toBe("pass");
    expect(new StormCycleBuffer(0).offer(item("z", "Hurricane Vance Public Advisory Number 11"), 0)).toBe("pass");
  });
});
