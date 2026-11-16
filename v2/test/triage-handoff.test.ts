// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { triageBook } from "../src/triage-book.js";
import { triageReadLine } from "../src/prompts.js";

describe("triage sees the book, not a symbol list (V2_TRIAGE_BOOK)", () => {
  const positions = [
    { symbol: "KXHURCAT-26VANCE-T4:NO", kind: "prediction", qty: 1764, avg_cost: 0.85, last_watch_price: 0.95 },
    { symbol: "USDJPY", kind: "fx", qty: -20000, avg_cost: 1, last_watch_price: 1 },
    { symbol: "DUSTY", kind: "equity", qty: 0.001, avg_cost: 10 },
    { symbol: "GONE", kind: "equity", qty: 0, avg_cost: 10 },
  ];
  it("drops dust and closed rows, sorts by value, carries side and a clipped one-line thesis", () => {
    const b = triageBook(positions, (s) => (s === "USDJPY" ? "Short yen\n  into the BoJ  " + "x".repeat(300) : undefined), { thesisChars: 40 });
    expect(b.map((p) => p.symbol)).toEqual(["USDJPY", "KXHURCAT-26VANCE-T4:NO"]);
    expect(b[0]).toMatchObject({ side: "short", kind: "fx", value_usd: 20000 });
    expect(b[0].thesis!.startsWith("Short yen into the BoJ")).toBe(true);
    expect(b[0].thesis!.length).toBe(40);
    expect(b[1]).toMatchObject({ side: "long", value_usd: 1676, thesis: null });
    expect(triageBook(positions, () => undefined, { max: 1 })).toHaveLength(1);
  });
});

describe("the investigator sees triage's whole read (V2_TRIAGE_HANDOFF)", () => {
  it("states every field and tells the agent to check it rather than inherit it", () => {
    const line = triageReadLine({ materiality: 0.7234, event_type: "disaster", regions: ["MX"], touches_positions: false, rationale: "Gulf oil risk" });
    expect(line).toContain('"materiality":0.72');
    expect(line).toContain('"touches_positions":false');
    expect(line).toContain("Gulf oil risk");
    expect(line).toMatch(/check it, do not inherit it/);
  });
});
