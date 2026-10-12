// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  DEFAULT_RATES,
  FALLBACK_RATES,
  rateFor,
  rateTable,
  priceUsage,
  priceSdkResult,
  estimateCostUsd,
  normalizeUsage,
} from "../src/pricing.js";
import { estimateCostUsd as estimateViaBudget, triageCostUsd, shouldMeterTriage } from "../src/budget.js";

const FABLE = "us.anthropic.claude-fable-5-1";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

describe("rateFor — model-id substring matching", () => {
  it("matches Bedrock inference-profile ids by substring, case-insensitively", () => {
    expect(rateFor(FABLE)).toMatchObject({ matched: true, key: "fable-5-1", rates: { input: 10, output: 50 } });
    expect(rateFor(HAIKU)).toMatchObject({ matched: true, key: "haiku-4-5", rates: { input: 1, output: 5 } });
    expect(rateFor("anthropic.claude-opus-5")).toMatchObject({ matched: true, key: "opus-5", rates: { input: 5, output: 25 } });
    expect(rateFor("us.amazon.nova-2-lite-v1:0")).toMatchObject({ matched: true, key: "nova-2-lite", rates: { input: 0.33, output: 2.75 } });
    expect(rateFor("US.ANTHROPIC.CLAUDE-SONNET-5")).toMatchObject({ matched: true, key: "sonnet-5" });
  });

  it("prefers the longest matching key: fable-5-1 over fable-5", () => {
    expect(rateFor(FABLE).key).toBe("fable-5-1");
    expect(rateFor("anthropic.claude-fable-5").key).toBe("fable-5");
    expect(rateFor("anthropic.claude-opus-4-1-20250805-v1:0")).toMatchObject({ key: "opus-4-1", rates: { input: 15, output: 75 } });
  });

  it("derives Anthropic cache columns from input (write 1.25x, read 0.10x)", () => {
    const { rates } = rateFor(FABLE);
    expect(rates.cacheWrite).toBeCloseTo(12.5, 9);
    expect(rates.cacheRead).toBeCloseTo(1.0, 9);
    expect(DEFAULT_RATES["haiku-4-5"]).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  it("falls back to a conservative rate for an unknown model and says so", () => {
    const r = rateFor("some-vendor.some-model-v9");
    expect(r.matched).toBe(false);
    expect(r.key).toBeNull();
    expect(r.rates).toEqual(FALLBACK_RATES);
    // Conservative = at least as expensive as anything in the table.
    for (const row of Object.values(DEFAULT_RATES)) {
      expect(FALLBACK_RATES.input).toBeGreaterThanOrEqual(row.input);
      expect(FALLBACK_RATES.output).toBeGreaterThanOrEqual(row.output);
    }
  });
});

describe("V2_MODEL_RATES_JSON override", () => {
  const override = JSON.stringify({
    "fable-5-1": { input: 8, output: 40 },
    "my-model": { input: 1, output: 2 },
    "haiku-4-5": { cacheRead: 0.05 },
  });

  it("merges over the defaults: replaces rows, adds rows, leaves the rest alone", () => {
    const table = rateTable(override);
    // Replaced input -> cache columns re-derived from the new input.
    expect(table["fable-5-1"]).toEqual({ input: 8, output: 40, cacheWrite: 10, cacheRead: 0.8 });
    // New row with the default cache convention.
    expect(table["my-model"]).toEqual({ input: 1, output: 2, cacheWrite: 1.25, cacheRead: 0.1 });
    // Partial override of one column keeps the other defaults.
    expect(table["haiku-4-5"]).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.05 });
    expect(table["sonnet-5"]).toEqual(DEFAULT_RATES["sonnet-5"]);
    // The defaults object itself is untouched.
    expect(DEFAULT_RATES["fable-5-1"].input).toBe(10);
  });

  it("is honoured by rateFor and priceUsage", () => {
    expect(rateFor(FABLE, { overrideJson: override }).rates.input).toBe(8);
    expect(rateFor("vendor.my-model-v1", { overrideJson: override })).toMatchObject({ matched: true, key: "my-model" });
    const p = priceUsage(FABLE, { input_tokens: 1_000_000 }, { overrideJson: override });
    expect(p.usd).toBeCloseTo(8, 9);
    expect(p.pricedWithFallback).toBe(false);
  });

  it("ignores malformed JSON and rows missing input/output, never throws", () => {
    expect(rateTable("not json {")).toEqual(rateTable(""));
    expect(rateTable('{"fable-5-1": 12}')).toEqual(rateTable(""));
    const t = rateTable('{"new-model": {"input": 3}}');
    expect(t["new-model"]).toBeUndefined();
    expect(rateTable("[1,2]")).toEqual(rateTable(""));
  });
});

describe("priceUsage", () => {
  it("prices a known Fable 5.1 usage to the expected figure, cache tokens included", () => {
    const usage = {
      input_tokens: 12_000,
      output_tokens: 3_000,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 400_000,
    };
    // 12k*$10 + 3k*$50 + 20k*$12.50 + 400k*$1.00 = 0.12 + 0.15 + 0.25 + 0.40
    const p = priceUsage(FABLE, usage);
    expect(p.usd).toBeCloseTo(0.92, 9);
    expect(p.pricedWithFallback).toBe(false);
    expect(p.usage).toEqual(usage);
  });

  it("matches the pre-pricing.ts Fable formula (input + 1.25x cache write, 0.1x cache read) exactly", () => {
    const u = { input_tokens: 51_234, output_tokens: 7_891, cache_creation_input_tokens: 33_210, cache_read_input_tokens: 812_345 };
    const legacy =
      ((u.input_tokens + u.cache_creation_input_tokens * 1.25) * 10 + u.cache_read_input_tokens * 10 * 0.1 + u.output_tokens * 50) /
      1e6;
    expect(priceUsage(FABLE, u).usd).toBeCloseTo(legacy, 12);
  });

  it("prices cache tokens at the cache columns, not the input column", () => {
    const p = priceUsage(HAIKU, { cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
    expect(p.usd).toBeCloseTo(1.25 + 0.1, 9);
  });

  it("flags an unknown model and prices it at the fallback", () => {
    const p = priceUsage("vendor.unknown-model", { input_tokens: 1_000_000, output_tokens: 100_000 });
    expect(p.pricedWithFallback).toBe(true);
    expect(p.usd).toBeCloseTo(FALLBACK_RATES.input + FALLBACK_RATES.output * 0.1, 9);
  });

  it("treats missing and null counters as zero", () => {
    expect(priceUsage(FABLE, null).usd).toBe(0);
    expect(priceUsage(FABLE, { input_tokens: null, cache_read_input_tokens: null }).usd).toBe(0);
    expect(normalizeUsage({ input_tokens: 5, output_tokens: null })).toEqual({
      input_tokens: 5,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
  });
});

describe("estimateCostUsd / priceSdkResult — Agent SDK results", () => {
  const usage = { input_tokens: 12_000, output_tokens: 3_000, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 400_000 };

  it("uses the token estimate when the SDK reports $0 for a Bedrock id it cannot price", () => {
    expect(estimateCostUsd({ total_cost_usd: 0, usage }, FABLE)).toBeCloseTo(0.92, 9);
  });

  it("keeps the SDK's own figure when it is the larger", () => {
    expect(estimateCostUsd({ total_cost_usd: 1.5, usage }, FABLE)).toBe(1.5);
    expect(estimateCostUsd({ total_cost_usd: 0.5, usage }, FABLE)).toBeCloseTo(0.92, 9);
  });

  it("carries the fallback flag and the normalized usage", () => {
    const r = priceSdkResult({ total_cost_usd: 0, usage }, "vendor.unknown");
    expect(r.pricedWithFallback).toBe(true);
    expect(r.usage).toEqual(usage);
    expect(priceSdkResult({ total_cost_usd: 0, usage }, FABLE).pricedWithFallback).toBe(false);
    expect(priceSdkResult({}, FABLE)).toMatchObject({ usd: 0, pricedWithFallback: false });
  });

  it("is re-exported from budget.ts for existing imports", () => {
    expect(estimateViaBudget).toBe(estimateCostUsd);
  });
});

describe("triage metering helpers (budget.ts)", () => {
  it("sums triage and enrichment cost, tolerating absent parts", () => {
    expect(triageCostUsd({ enrichment: { cost_usd: 0.004 } }, { cost_usd: 0.006 })).toBeCloseTo(0.01, 9);
    expect(triageCostUsd({}, { cost_usd: 0.006 })).toBeCloseTo(0.006, 9);
    expect(triageCostUsd({ enrichment: { cost_usd: 0.004 } }, null)).toBeCloseTo(0.004, 9);
    expect(triageCostUsd({}, undefined)).toBe(0);
  });

  it("is off unless V2_METER_TRIAGE is set", () => {
    if (!process.env.V2_METER_TRIAGE) expect(shouldMeterTriage()).toBe(false);
  });
});
