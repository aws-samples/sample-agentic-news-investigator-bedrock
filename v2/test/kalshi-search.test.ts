// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { rankKalshi, type KalshiHit } from "../src/quotes/kalshi-search.js";

const h = (title: string, v: number): KalshiHit => ({ symbol: `${title.slice(0, 4).toUpperCase()}:YES`, title, event: "EV", category: "Economics", yesBid: 0.4, yesAsk: 0.42, volume24h: v, closes: "2026-10-28T18:00:00Z" });

describe("kalshi search ranking", () => {
  it("ranks by word coverage, then 24h volume; drops weak matches", () => {
    const hits = [h("Fed decision in October — Hike 25bps", 100), h("Fed decision in October — Hold", 900), h("CPI in October above 3.4%", 50)];
    const r = rankKalshi(hits, "Fed October hike", 5);
    expect(r[0].title).toContain("Hike 25bps");
    expect(r.map((x) => x.title)).not.toContain("CPI in October above 3.4%");
    expect(rankKalshi(hits, "", 5)).toEqual([]);
  });
});
