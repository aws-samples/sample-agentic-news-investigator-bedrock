// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { subjectQueries, matchesSubject } from "../src/triage-contracts.js";
import { openAt, type KalshiHit } from "../src/quotes/kalshi-search.js";
import { marketOpenAt } from "../src/quotes/prediction.js";

describe("triage contract lookup", () => {
  it("a storm product queries the storm's name and requires a storm word (JD Vance is not Hurricane Vance)", () => {
    const [q, ...rest] = subjectQueries({ headline: "Hurricane Vance Forecast Advisory Number 11", source_family: "disaster" });
    expect(rest).toEqual([]);
    expect(q.q).toBe("hurricane vance");
    expect(matchesSubject("Will Vance peak at Category 3?", q)).toBe(true);
    expect(matchesSubject("Hurricane Vance category? — 4", q)).toBe(true);
    expect(matchesSubject("Will Trump endorse JD Vance for president before 2027?", q)).toBe(false);
  });

  it("central-bank acronyms query the country the contracts are titled by", () => {
    const qs = subjectQueries({ headline: "RBNZ expected to hike OCR to 3.0% this week", source_family: "macro" });
    expect(qs[0]).toMatchObject({ q: "new zealand", must: ["new", "zealand"] });
    expect(subjectQueries({ headline: "Fed's Waller says cuts can wait", source_family: "macro" })[0].q).toBe("fed");
  });

  it("other news queries its named subjects, longest first, without headline boilerplate", () => {
    const qs = subjectQueries({
      headline: "Weekend - China warns of countermeasures as US Treasury widens tech investment curbs to biotech",
      source_family: "news",
    });
    expect(qs.map((q) => q.q)).toEqual(["china", "treasury"]);
    expect(subjectQueries({ headline: "markets drift lower in quiet trade", source_family: "news" })).toEqual([]);
  });
});

describe("as-of contract existence (bench: no contract that did not exist yet, none that had closed)", () => {
  const t = Date.parse("2026-10-24T02:46:00Z");
  it("Kalshi: opened at or before, closing after", () => {
    const h = (opens: string | undefined, closes: string): KalshiHit => ({
      symbol: "X:YES", title: "x", event: "E", category: "c", yesBid: null, yesAsk: null, volume24h: null, opens, closes,
    });
    expect(openAt([h("2026-10-01T00:00:00Z", "2026-10-30T00:00:00Z")], t)).toHaveLength(1);
    expect(openAt([h("2026-10-25T00:00:00Z", "2026-10-30T00:00:00Z")], t)).toHaveLength(0);
    expect(openAt([h("2026-10-01T00:00:00Z", "2026-10-23T00:00:00Z")], t)).toHaveLength(0);
    expect(openAt([h(undefined, "2026-10-30T00:00:00Z")], t)).toHaveLength(1);
  });
  it("Polymarket: created before, closedTime (venue format) or endDate after", () => {
    expect(marketOpenAt({ createdAt: "2026-10-20T00:00:00Z", endDate: "2026-11-01T00:00:00Z" }, t)).toBe(true);
    expect(marketOpenAt({ createdAt: "2026-10-25T00:00:00Z", endDate: "2026-11-01T00:00:00Z" }, t)).toBe(false);
    expect(marketOpenAt({ createdAt: "2026-10-20T00:00:00Z", closedTime: "2026-10-23 10:06:59+00", endDate: "2026-11-01T00:00:00Z" }, t)).toBe(false);
    expect(marketOpenAt({ createdAt: "2026-10-20T00:00:00Z", closedTime: "2026-10-25 10:06:59+00" }, t)).toBe(true);
    expect(marketOpenAt({}, t)).toBe(false);
  });
});
