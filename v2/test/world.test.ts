// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { basinOf, basinConflict, priceDeviation, PRICE_TOLERANCE } from "../src/gate.js";
import { slug, normalizeId, renderWorldModel, type PositionView, type WorldModelView } from "../src/world.js";
import { findIssues, pickIssue, type Issue } from "../src/curiosity.js";
import { TRIAGE_SYSTEM, TRIAGE_SYSTEM_WORLD } from "../src/prompts.js";
import { defaultFactHours, defaultEdgeHours } from "../src/worldwrite.js";

describe("basinOf", () => {
  it("puts the storms the agent confused on the right side of the isthmus", () => {
    expect(basinOf(18.9, -133.8)).toBe("pacific"); // Karina, central Pacific
    expect(basinOf(13.3, -154.3)).toBe("pacific"); // Lowell
    expect(basinOf(20.0, -108.0)).toBe("pacific"); // off Baja / Marie
    expect(basinOf(15.0, -95.0)).toBe("pacific"); // Gulf of Tehuantepec side
    expect(basinOf(25.0, -90.0)).toBe("atlantic"); // Gulf of Mexico
    expect(basinOf(27.5, -96.0)).toBe("atlantic"); // off Texas
    expect(basinOf(14.0, -70.0)).toBe("atlantic"); // Caribbean
    expect(basinOf(30.0, -50.0)).toBe("atlantic"); // open Atlantic
  });
  it("returns other for the rest of the world and bad input", () => {
    expect(basinOf(20, 130)).toBe("other");
    expect(basinOf(15, 60)).toBe("other");
    expect(basinOf(NaN, -90)).toBe("other");
  });
});

describe("basinConflict", () => {
  const texas = { type: "region", id: "texas", label: "Texas coast", props: {} };
  it("rejects a Pacific storm threatening a Gulf region, with the reason spelled out", () => {
    const lowell = { type: "storm", id: "lowell-2026", label: "Hurricane Lowell", props: { basin: "pacific" } };
    expect(basinConflict(lowell, texas)).toMatch(/pacific basin.*Texas coast.*cannot make landfall/);
  });
  it("accepts a Gulf storm and a Gulf region", () => {
    const gulf = { type: "storm", id: "x", label: "TS X", props: { basin: "atlantic" } };
    expect(basinConflict(gulf, texas)).toBeNull();
  });
  it("demands coordinates before it will judge", () => {
    const nowhere = { type: "storm", id: "y", label: "TS Y", props: {} };
    expect(basinConflict(nowhere, texas)).toMatch(/no position/);
  });
  it("cannot rule out a region whose basin is unknown", () => {
    const lowell = { type: "storm", id: "l", label: "L", props: { basin: "pacific" } };
    expect(basinConflict(lowell, { type: "region", id: "atlantis", label: "Atlantis", props: {} })).toBeNull();
  });
});

describe("priceDeviation", () => {
  it("catches Brent quoted as WTI", () => {
    expect(priceDeviation(93, 90.76)).toBeGreaterThan(PRICE_TOLERANCE * 0.4);
    expect(priceDeviation(95.36, 90.76)).toBeGreaterThan(PRICE_TOLERANCE);
    expect(priceDeviation(90.5, 90.76)).toBeLessThan(PRICE_TOLERANCE);
    expect(priceDeviation(10, 0)).toBe(0);
  });
});

describe("ids", () => {
  it("slugs everything except instrument symbols", () => {
    expect(slug("Hurricane Lowell (2026)")).toBe("hurricane-lowell-2026");
    expect(normalizeId("storm", "Hurricane Lowell")).toBe("hurricane-lowell");
    expect(normalizeId("instrument", "CL=F")).toBe("CL=F");
    expect(normalizeId("contract", "will-wti-reach-100-in-september-2026:YES")).toBe("will-wti-reach-100-in-september-2026:YES");
  });
});

describe("renderWorldModel", () => {
  it("prints facts, drivers with basin, signs and staleness the agent can read", () => {
    const v: WorldModelView = {
      as_of: "2026-09-02T23:00:00.000Z",
      positions: [
        {
          symbol: "will-wti-reach-100-in-september-2026:YES",
          label: "WTI touches $100 in Sep 2026",
          props: {},
          facts: [{ key: "resolution_rule", value: "any 1-min high of active CL future >= 100", as_of: "2026-09-02T22:00:00Z", source: "polymarket", stale: false }],
          exposures: [
            {
              rel: "resolves_on",
              sign: 1,
              mechanism: "settles on the active-month WTI future",
              confidence: 1,
              stale: false,
              driver: { type: "commodity", id: "wti", label: "WTI crude", props: { quote_symbol: "CL=F" }, facts: [{ key: "price", value: 90.76, unit: "USD/bbl", as_of: "2026-09-02T23:00:00Z", source: "CL=F", stale: true }] },
            },
          ],
        },
        { symbol: "SPY", label: null, props: {}, facts: [], exposures: [] },
      ],
      warnings: ["SPY: no exposure links recorded"],
    };
    const out = renderWorldModel(v);
    expect(out).toContain("resolves_on + commodity:WTI crude");
    expect(out).toContain("price = 90.76 USD/bbl");
    expect(out).toContain("STALE");
    expect(out).toContain("exposures: none recorded");
    expect(out).toContain("warnings: SPY");
  });
});

describe("pickIssue", () => {
  const issues: Issue[] = [
    { kind: "stale", subject: "a", severity: 1, detail: "", symbols: [] },
    { kind: "contradiction", subject: "b", severity: 3, detail: "", symbols: [] },
    { kind: "unmodelled", subject: "c", severity: 2, detail: "", symbols: [] },
  ];
  it("takes the most severe issue not under cooldown", () => {
    expect(pickIssue(issues, new Map(), 1000)!.subject).toBe("b");
    expect(pickIssue(issues, new Map([["b", 5000]]), 1000)!.subject).toBe("c");
    expect(pickIssue(issues, new Map([["b", 500]]), 1000)!.subject).toBe("b");
  });
  it("returns null when everything is cooling", () => {
    expect(pickIssue(issues, new Map([["a", 9], ["b", 9], ["c", 9]]), 1)).toBeNull();
  });
});

describe("default expiries", () => {
  it("lets prices go stale fast and structure never", () => {
    expect(defaultFactHours("commodity", "price")).toBe(6);
    expect(defaultFactHours("storm", "position")).toBe(12);
    expect(defaultFactHours("contract", "resolution_rule")).toBe(72);
    expect(defaultEdgeHours("threatens")).toBe(24);
    expect(defaultEdgeHours("exposure")).toBe(7 * 24);
    expect(defaultEdgeHours("resolves_on")).toBeNull();
  });
});

describe("findIssues on an empty book", () => {
  const view = (positions: PositionView[]): WorldModelView => ({
    as_of: new Date().toISOString(),
    positions,
    warnings: [],
  });
  const noPrice = async () => null;

  it("asks about a book that holds nothing, since every other check starts from a position", async () => {
    const issues = await findIssues(view([]), noPrice);
    expect(issues.map((i) => i.kind)).toEqual(["idle"]);
    expect(issues[0].subject).toBe("book:empty");
  });

  it("stops asking as soon as anything is held", async () => {
    const held: PositionView = { symbol: "CL=F", label: "WTI", props: {}, facts: [], exposures: [] };
    const issues = await findIssues(view([held]), noPrice);
    expect(issues.some((i) => i.kind === "idle")).toBe(false);
    expect(issues.map((i) => i.kind)).toContain("unmodelled");
  });
});

describe("world-aware triage", () => {
  it("narrows touches_positions without licensing a lower materiality", () => {
    expect(TRIAGE_SYSTEM_WORLD).toContain("touches_positions=true ONLY when the news bears on");
    expect(TRIAGE_SYSTEM_WORLD).toContain("narrows touches_positions and nothing else");
    expect(TRIAGE_SYSTEM_WORLD).toContain("materiality alone decides");
  });

  it("adds only the exposed_to specifics on top of the shared prompt", () => {
    expect(TRIAGE_SYSTEM_WORLD.startsWith(TRIAGE_SYSTEM)).toBe(true);
    expect(TRIAGE_SYSTEM).not.toContain("touches_positions and nothing else");
    expect(TRIAGE_SYSTEM).not.toContain("exposed_to");
  });

  // The discipline itself belongs to BOTH arms (user decision 2026-09-03): six of
  // v2's first eighteen equity investigations were opened on hypotheses no
  // mechanism supported — Pacific storms pointed at Gulf oil, XLE, EWW and a
  // Hawaiian utility. It lived only in the world variant, so the control arm,
  // which has no exposed_to to check against, never saw it.
  // The mechanism test, first written 2026-09-03, over-corrected: on the bench it
  // took nine 8-K delisting/bankruptcy filings from 0.65-0.70 down to 0.15, every
  // rationale reciting "micro-cap, illiquid, no systemic footprint". Triage was
  // demanding that the news reach a liquid INDEX when the filer's own equity was
  // the instrument all along — and a $1,500 short of exactly that filing is the
  // one trade the bench has ever produced. Both halves have to stay in the prompt.
  it("keeps the filer's own security admissible while refusing sympathy legs", () => {
    for (const prompt of [TRIAGE_SYSTEM, TRIAGE_SYSTEM_WORLD]) {
      expect(prompt).toContain("filer's own listed security IS the instrument");
      expect(prompt).toContain("Do NOT decline a filing because the company looks small");
      expect(prompt).toContain("1.03 bankruptcy or receivership");
      expect(prompt).toContain("SUBJECT of the news is always an admissible instrument");
      expect(prompt).not.toContain("only at index/sector scale");
      // 2026-09-05: 41 EDGAR investigations for 8 trade attempts because item codes were
      // "decisive on their own" (Monster's 5.02 comp change scored 0.72 as an "abrupt exit").
      // The Filing summary line (enrich.ts) is what triage scores; codes alone cap at 0.4;
      // a merger closing's 3.01 is not a listing failure.
      expect(prompt).toContain('"Filing summary:" line');
      expect(prompt).toContain("merger closing");
      expect(prompt).toContain("no higher than 0.4");
      expect(prompt).not.toContain("Decisive (>= 0.5 on their own)");
    }
  });

  it("gives both arms the mechanism test, not just the world-model arm", () => {
    for (const prompt of [TRIAGE_SYSTEM, TRIAGE_SYSTEM_WORLD]) {
      expect(prompt).toContain("a mechanism, not a resemblance");
      expect(prompt).toContain("Pacific-basin storm does not touch a Gulf landfall contract");
      expect(prompt).toContain("EMPTY hypotheses list rather than a guess");
    }
  });
});

describe("deployment mandate in the investigator prompt", () => {
  it("makes both arms portfolio managers with a sizing ladder, and retires the hold-is-a-win framing", async () => {
    const { investigatorSystem } = await import("../src/prompts.js");
    for (const worldModel of [false, true]) {
      const p = investigatorSystem({ dryRun: false, worldModel });
      expect(p).toContain("portfolio manager, not an analyst");
      expect(p).toContain("0.55 → about 1% of equity as a starter");
      expect(p).toContain("describes the first move, not the next week");
      expect(p).toContain("counts against you exactly as a losing trade does");
      expect(p).not.toContain("first-class outcome");
      expect(p).not.toContain("restraint gets credit");
      expect(p).not.toContain("prefer hold unless");
    }
  });
});
