// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildFinTools, type BookView } from "../src/tools.js";

// Bench mode of the fin tools: the agent must see the simulated book, this run's
// own prior reasoning, and as-of quotes — and never a live quote or the live ledger.
async function client(opts: Parameters<typeof buildFinTools>[0]) {
  const { server } = buildFinTools(opts);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await (server as any).instance.connect(st);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as any;
    return JSON.parse(r.content[0].text);
  };
  return { call, close: () => c.close() };
}

const book: BookView = {
  getPortfolio: async () => ({ cash: 12345, realized_pnl_today: 7, day_key: "2026-08-24" }),
  listPositions: async () => [{ symbol: "FLZH", qty: -100, avg_cost: 0.95, kind: "equity" }],
  recentTrades: async (symbol) => [{ symbol, side: "sell", qty: 100 }],
  decisionHistory: async (symbol) => ({ symbol, latest: { action: "sell", rationale: "bench-local" } }),
};

describe("fin MCP server in bench mode", () => {
  const asOfMs = Date.UTC(2026, 7, 24, 14, 0, 0);
  const opts = {
    search: null,
    newsId: "t",
    bench: true,
    asOfMs,
    book,
    // No tape row and no bars: the only honest answer is "no historical quote".
    asOfDeps: { tape: async () => null, bars: async () => [] as any[], nowMs: asOfMs + 30 * 86_400_000 },
  };

  it("portfolio tools read the injected book, not the live ledger", async () => {
    const c = await client(opts);
    expect((await c.call("get_portfolio")).cash).toBe(12345);
    expect((await c.call("get_positions"))[0]).toMatchObject({ symbol: "FLZH", qty: -100 });
    expect((await c.call("get_recent_trades", { symbol: "FLZH" }))[0]).toMatchObject({ side: "sell" });
    expect((await c.call("get_decision_history", { symbol: "FLZH" })).latest.rationale).toBe("bench-local");
    await c.close();
  });

  it("resolve_instrument answers as-of and refuses rather than falling through to live", async () => {
    const c = await client(opts);
    const eq = await c.call("resolve_instrument", { symbol: "FLZH" });
    expect(eq.ok).toBe(false);
    expect(eq.reason).toMatch(/no historical quote/i);
    const pm = await c.call("resolve_instrument", { symbol: "some-market:YES", kind: "prediction" });
    expect(pm.ok).toBe(false);
    await c.close();
  });

  it("without asOfMs the live path is used (tool still lists)", async () => {
    const { server } = buildFinTools({ search: null, newsId: "t" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await (server as any).instance.connect(st);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(ct);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toContain("resolve_instrument");
    await c.close();
  });
});
