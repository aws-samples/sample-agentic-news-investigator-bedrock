// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The Agent SDK's tool() helper cannot convert every Zod construct to JSON schema
// (z.record, z.union). When one tool's schema fails, tools/list throws for the WHOLE
// server: it reports "connected" and the agent sees no fin tools at all, ending every
// investigation in a zero-confidence hold (observed 2026-09-02 on the v3 smoke run).
// This lists the tools exactly as the runtime does.
process.env.V2_WORLD_MODEL = "1";
const { buildFinTools } = await import("../src/tools.js");

describe("fin MCP server", () => {
  it("lists every tool, world-model tools included, with serialisable schemas", async () => {
    const { server } = buildFinTools({ search: null, newsId: "test" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await (server as any).instance.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "get_decision_history", "get_portfolio", "get_positions", "get_recent_trades", "get_world_model",
        "link_exposure", "read_source", "record_fact", "resolve_instrument", "search_markets", "submit_decision",
        "web_search",
      ].sort(),
    );
    for (const t of tools) expect(() => JSON.stringify(t.inputSchema)).not.toThrow();
    await client.close();
  });
  async function callWebSearch(opts: Record<string, unknown>): Promise<string> {
    const { server } = buildFinTools({ search: async () => "observation text", newsId: "test", ...opts });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await (server as any).instance.connect(st);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(ct);
    const r = (await client.callTool({ name: "web_search", arguments: { query: "q" } })) as any;
    await client.close();
    return r.content[0].text;
  }

  it("passes web_search output through untouched with no guardrail", async () => {
    let called = false;
    const out = await callWebSearch({ guardrail: null, guardrailApply: async () => ((called = true), { action: "NONE" }) });
    expect(out).toBe("observation text");
    expect(called).toBe(false);
  });

  it("withholds web_search output the guardrail intervenes on", async () => {
    const out = await callWebSearch({
      guardrail: { id: "g", version: "1" },
      guardrailApply: async () => ({
        action: "GUARDRAIL_INTERVENED",
        assessments: [{ contentPolicy: { filters: [{ type: "PROMPT_ATTACK", action: "BLOCKED" }] } }],
      }),
    });
    expect(out).toMatch(/withheld by the content guardrail \(PROMPT_ATTACK\)/);
    expect(out).not.toContain("observation text");
  });
});
