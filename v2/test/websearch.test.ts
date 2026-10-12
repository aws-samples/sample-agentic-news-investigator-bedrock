// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { NO_FACTS, WebSearch, observationFromConverse } from "../src/websearch.js";

// Nova 2 Lite us-east-1 list prices, 2026-09-04 (config.nova carries the live copy).
const rates = { inputPerMTok: 0.33, outputPerMTok: 2.75, groundingPerRequest: 0.03 };

// A citation block exactly as Nova returned it on 2026-09-04: empty generated
// content, one web location.
const cite = (url: string) => ({
  citationsContent: {
    content: [],
    citations: [{ location: { web: { url, domain: new URL(url).hostname } } }],
  },
});

const reply = (content: unknown[], usage = { inputTokens: 0, outputTokens: 0 }) =>
  ({ output: { message: { role: "assistant", content } }, usage }) as any;

describe("observationFromConverse", () => {
  it("reads the prose from text blocks, skips the model's own search traffic, appends deduplicated sources", () => {
    const o = observationFromConverse(
      reply(
        [
          { toolUse: { toolUseId: "1", name: "nova_grounding", input: {} } },
          { toolResult: { toolUseId: "1", content: [] } },
          { toolUse: { toolUseId: "2", name: "nova_grounding", input: {} } },
          { toolResult: { toolUseId: "2", content: [] } },
          { text: "FedWatch showed 50.2% after the print" },
          cite("https://a.example/x"),
          { text: ", down from 62.2% two days earlier" },
          cite("https://a.example/x"),
          cite("https://b.example/y"),
          { text: "." },
        ],
        { inputTokens: 1000, outputTokens: 1000 },
      ),
      rates,
    );
    expect(o.text).toBe(
      "FedWatch showed 50.2% after the print, down from 62.2% two days earlier.\n\n" +
        "Sources: https://a.example/x ; https://b.example/y",
    );
    expect(o.sources).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(o.searches).toBe(2);
    // $0.03 per request + 1k tokens in at $0.33/M + 1k out at $2.75/M.
    expect(o.costUsd).toBeCloseTo(0.03 + 0.00033 + 0.00275, 9);
  });

  it("reads a cited segment carried inside the citation block", () => {
    const o = observationFromConverse(
      reply([
        {
          citationsContent: {
            content: [{ text: "Brent settled at $91.40" }],
            citations: [{ location: { web: { url: "https://c.example/z", domain: "c.example" } } }],
          },
        },
      ]),
      rates,
    );
    expect(o.text).toBe("Brent settled at $91.40\n\nSources: https://c.example/z");
  });

  it("says no facts rather than returning an empty string, and still charges the request", () => {
    const o = observationFromConverse(reply([{ text: "  \n" }], { inputTokens: 200, outputTokens: 5 }), rates);
    expect(o.text).toBe(NO_FACTS);
    expect(o.sources).toEqual([]);
    expect(o.costUsd).toBeGreaterThan(0.03);
  });

  it("ignores citations that are not web locations", () => {
    const o = observationFromConverse(
      reply([
        { text: "From the filing" },
        { citationsContent: { content: [], citations: [{ location: { documentChar: { documentIndex: 0 } } }] } },
      ]),
      rates,
    );
    expect(o.text).toBe("From the filing");
    expect(o.sources).toEqual([]);
  });
});

describe("WebSearch", () => {
  it("start() returns null when the backend is off (degraded mode)", async () => {
    expect(await WebSearch.start({ backend: "off" })).toBeNull();
  });

  it("refuses a backend it does not know rather than silently running degraded", async () => {
    await expect(WebSearch.start({ backend: "bing" })).rejects.toThrow(/unknown backend/);
  });

  it("a session tallies every grounded call's cost and phrases each query against the event", async () => {
    const inputs: any[] = [];
    const fake = async (input: any) => {
      inputs.push(input);
      return reply([{ text: "ok" }]);
    };
    const ws = new WebSearch(fake, { model: "test-model", rates, timeoutMs: 1000 });
    const s = ws.session("Hurricane Karina forecast advisory 12");
    expect(await s.search("Karina landfall Gulf")).toBe("ok");
    await s.search("Karina intensity");
    expect(s.calls).toBe(2);
    expect(s.costUsd).toBeCloseTo(0.06, 9);
    expect(inputs[0].modelId).toBe("test-model");
    expect(inputs[0].toolConfig.tools[0].systemTool.name).toBe("nova_grounding");
    expect(inputs[0].messages[0].content[0].text).toContain("Hurricane Karina forecast advisory 12");
    expect(inputs[0].messages[0].content[0].text).toContain("Karina landfall Gulf");
    expect(inputs[0].system[0].text).toContain("No relevant facts found.");
  });

  it("searchAndExtract keeps the old text-only contract", async () => {
    const ws = new WebSearch(async () => reply([{ text: "brief" }]), { model: "m", rates, timeoutMs: 1000 });
    expect(await ws.searchAndExtract("q", "event")).toBe("brief");
  });
});
