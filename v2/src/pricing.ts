// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";

/**
 * Per-model LLM pricing: the one place token counts become dollars.
 *
 * Every model call in v2/v3 reports usage (input, output, cache-write and
 * cache-read tokens) but Bedrock bills by model, and the Agent SDK's own
 * `total_cost_usd` is 0 for Bedrock model ids it does not recognise. This
 * module turns a model id plus usage into USD, so the budget breaker, the
 * decision row and the letter agree on what a call cost whichever model is
 * configured.
 *
 * THE DEFAULT TABLE IS A DEFAULT TO OVERRIDE, NOT A SOURCE OF TRUTH. On-demand
 * list prices in USD per million tokens as known on 2026-09-11: Anthropic
 * models at their published Bedrock/first-party rates (cache write = 1.25x
 * input, cache read = 0.10x input, the standard Anthropic prompt-caching
 * convention), Amazon Nova 2 Lite from the AWS Pricing API on 2026-09-04
 * (config.nova carries the same numbers for the grounding path, with the
 * $0.03/request grounding fee that has no per-token analogue here). Prices
 * change, regions differ, provisioned throughput and batch are cheaper;
 * V2_MODEL_RATES_JSON overrides any row or adds new ones:
 *
 *   V2_MODEL_RATES_JSON='{"fable-5-1":{"input":10,"output":50,"cacheRead":0.25},
 *                         "my-model":{"input":1,"output":2}}'
 *
 * Note on Fable 5.1 cache reads: Anthropic's first-party price list shows
 * $0.25/MTok (2.5% of input) for Fable 5.1 where every other current model
 * reads at 10%. This table keeps the 10% convention ($1.00/MTok) that the
 * private arms have been metered at since inception, so the spend series stays
 * comparable; override the row to price at the first-party figure.
 *
 * Keys are SUBSTRINGS of the Bedrock/first-party model id (`us.anthropic.claude-
 * haiku-4-5-20251001-v1:0` matches `haiku-4-5`); the longest matching key wins,
 * so `fable-5-1` beats `fable-5`. Unknown models are priced at a deliberately
 * expensive fallback and flagged, so a misconfigured model id trips the daily
 * breaker early rather than running unmetered.
 */

/** USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  /** Prompt-cache write (cache_creation_input_tokens). */
  cacheWrite: number;
  /** Prompt-cache read (cache_read_input_tokens). */
  cacheRead: number;
}

/** Token counts as the Anthropic API / Agent SDK report them (snake_case). */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** A fully populated, all-numeric usage record — what the audit rows persist. */
export interface NormalizedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Date the default table was last checked against list prices. */
export const RATES_AS_OF = "2026-09-11";

const anthropic = (input: number, output: number): Rates => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: input * 0.1,
});

/** Default rate table, USD per million tokens, keyed by model-id substring. */
export const DEFAULT_RATES: Readonly<Record<string, Rates>> = Object.freeze({
  // Anthropic — Fable tier.
  "fable-5-1": anthropic(10, 50),
  "fable-5": anthropic(10, 50),
  // Anthropic — Opus tier. Opus 4.5 and later are $5/$25; Opus 4 and 4.1 were $15/$75.
  "opus-5": anthropic(5, 25),
  "opus-4-8": anthropic(5, 25),
  "opus-4-7": anthropic(5, 25),
  "opus-4-6": anthropic(5, 25),
  "opus-4-5": anthropic(5, 25),
  "opus-4-1": anthropic(15, 75),
  "opus-4-20250514": anthropic(15, 75),
  // Anthropic — Sonnet tier. Sonnet 5 dropped to $2/$10; 3.5 through 4.6 were $3/$15.
  "sonnet-5": anthropic(2, 10),
  "sonnet-4-6": anthropic(3, 15),
  "sonnet-4-5": anthropic(3, 15),
  "sonnet-4-20250514": anthropic(3, 15),
  "3-7-sonnet": anthropic(3, 15),
  "3-5-sonnet": anthropic(3, 15),
  // Anthropic — Haiku tier.
  "haiku-4-5": anthropic(1, 5),
  "3-5-haiku": anthropic(0.8, 4),
  // Amazon Nova 2 Lite (the grounded-search model): us-east-1 on-demand, AWS
  // Pricing API 2026-09-04. Nova prompt caching bills cache reads at 25% of
  // input and charges no write premium.
  "nova-2-lite": { input: 0.33, output: 2.75, cacheWrite: 0.33, cacheRead: 0.0825 },
});

/**
 * What an unknown model is priced at: the most expensive Anthropic tier ever
 * listed (Opus 4 / 4.1). Deliberately conservative — over-counting spend trips
 * the breaker early; under-counting lets a mis-set model id run unmetered.
 */
export const FALLBACK_RATES: Readonly<Rates> = Object.freeze(anthropic(15, 75));

/** Loose shape accepted in V2_MODEL_RATES_JSON: cache columns may be omitted. */
interface RatesOverride {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Merge one override row over a base row. `input` and `output` are required
 * when the key is new; cache columns default to the Anthropic convention
 * (write 1.25x input, read 0.10x input) computed from the override's input.
 */
function mergeRow(key: string, base: Rates | undefined, over: RatesOverride): Rates | null {
  const input = finite(over.input) ? over.input : base?.input;
  const output = finite(over.output) ? over.output : base?.output;
  if (!finite(input) || !finite(output)) {
    console.warn(`[pricing] V2_MODEL_RATES_JSON["${key}"]: input and output are required for a new row; ignored`);
    return null;
  }
  const inputChanged = finite(over.input) && over.input !== base?.input;
  return {
    input,
    output,
    cacheWrite: finite(over.cacheWrite) ? over.cacheWrite : inputChanged || !base ? input * 1.25 : base.cacheWrite,
    cacheRead: finite(over.cacheRead) ? over.cacheRead : inputChanged || !base ? input * 0.1 : base.cacheRead,
  };
}

const tableCache = new Map<string, Record<string, Rates>>();

/**
 * The effective rate table: defaults with `overrideJson` (default
 * `config.modelRatesJson`, i.e. V2_MODEL_RATES_JSON) merged over them. Never
 * throws — malformed JSON is logged once and the defaults are used.
 */
export function rateTable(overrideJson: string = config.modelRatesJson): Record<string, Rates> {
  const key = overrideJson.trim();
  const hit = tableCache.get(key);
  if (hit) return hit;
  const table: Record<string, Rates> = { ...DEFAULT_RATES };
  if (key) {
    try {
      const parsed = JSON.parse(key) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("expected a JSON object of model-id substring -> rates");
      }
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!v || typeof v !== "object") {
          console.warn(`[pricing] V2_MODEL_RATES_JSON["${k}"]: not an object; ignored`);
          continue;
        }
        const row = mergeRow(k, table[k], v as RatesOverride);
        if (row) table[k] = row;
      }
    } catch (e) {
      console.warn(`[pricing] V2_MODEL_RATES_JSON ignored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  tableCache.set(key, table);
  return table;
}

/**
 * Rates for a model id: the longest table key that is a substring of the id.
 * `matched: false` means the fallback is in use — persist that next to any
 * dollar figure derived from it.
 */
export function rateFor(
  modelId: string,
  opts: { overrideJson?: string } = {},
): { rates: Rates; matched: boolean; key: string | null } {
  const table = rateTable(opts.overrideJson);
  const id = (modelId ?? "").toLowerCase();
  let best: string | null = null;
  for (const k of Object.keys(table)) {
    if (id.includes(k.toLowerCase()) && (best === null || k.length > best.length)) best = k;
  }
  return best ? { rates: table[best], matched: true, key: best } : { rates: FALLBACK_RATES, matched: false, key: null };
}

/**
 * Usage as the audit rows persist it: the four Anthropic token counters, all
 * numbers, nulls and gaps read as 0. Accepts the Anthropic Messages API shape
 * (snake_case), which is also what the Agent SDK's result `usage` carries.
 */
export function normalizeUsage(u: Usage | null | undefined): NormalizedUsage {
  const n = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    input_tokens: n(u?.input_tokens),
    output_tokens: n(u?.output_tokens),
    cache_creation_input_tokens: n(u?.cache_creation_input_tokens),
    cache_read_input_tokens: n(u?.cache_read_input_tokens),
  };
}

export interface Priced {
  usd: number;
  /** True when `modelId` matched no table row and FALLBACK_RATES were used. */
  pricedWithFallback: boolean;
  rates: Rates;
  usage: NormalizedUsage;
}

/** Dollar cost of one call's usage at the model's rates. */
export function priceUsage(
  modelId: string,
  usage: Usage | null | undefined,
  opts: { overrideJson?: string } = {},
): Priced {
  const { rates, matched } = rateFor(modelId, opts);
  const u = normalizeUsage(usage);
  const usd =
    (u.input_tokens * rates.input +
      u.output_tokens * rates.output +
      u.cache_creation_input_tokens * rates.cacheWrite +
      u.cache_read_input_tokens * rates.cacheRead) /
    1e6;
  return { usd, pricedWithFallback: !matched, rates, usage: u };
}

/** The fields of an Agent SDK result message that pricing reads. */
export interface SdkResultLike {
  total_cost_usd?: number | null;
  usage?: Usage | null;
}

/**
 * Price an Agent SDK result. The SDK's `total_cost_usd` is a client-side
 * estimate that reports 0 for Bedrock model ids it cannot price, so the
 * token-based figure at `modelId`'s rates is computed too and the larger of
 * the two is used (they agree when the SDK knows the model).
 */
export function priceSdkResult(result: SdkResultLike, modelId: string = config.masterModel): Priced {
  const reported = finite(result.total_cost_usd ?? undefined) ? (result.total_cost_usd as number) : 0;
  const priced = priceUsage(modelId, result.usage);
  return { ...priced, usd: Math.max(reported, priced.usd) };
}

/**
 * Cost of an Agent SDK result in USD (the historical budget.ts entry point,
 * re-exported there). Prefer priceSdkResult when the fallback flag matters.
 */
export function estimateCostUsd(result: SdkResultLike, modelId: string = config.masterModel): number {
  return priceSdkResult(result, modelId).usd;
}
