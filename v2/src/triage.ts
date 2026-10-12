// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import { bedrock as client } from "./bedrock.js";
import { TRIAGE_SYSTEM, TRIAGE_SYSTEM_WORLD } from "./prompts.js";
import { priceUsage, type NormalizedUsage } from "./pricing.js";
import type { NewsItem } from "./types.js";
import { blockedSide, guardedCall, messageIntervened, type GuardrailRef } from "./guardrail.js";
import { activeGuardrail } from "./guardrail-runtime.js";

export interface TriageVerdict {
  materiality: number;
  event_type: string;
  regions: string[];
  touches_positions: boolean;
  hypotheses: string[];
  rationale: string;
  /**
   * What the call cost: Haiku's reported token usage, the dollars at
   * config.triageModel's rates (pricing.ts) and which model that was. Spread
   * into the v2-triage / bench-triage audit rows with the rest of the verdict;
   * metered into the daily spend only under V2_METER_TRIAGE (budget.ts).
   */
  usage?: NormalizedUsage;
  cost_usd?: number;
  model?: string;
  /**
   * Set when the Bedrock guardrail blocked the call (guardrail.ts): the verdict
   * is then "not material" by construction, never a real triage judgment.
   */
  guardrail_intervened?: "input" | "output";
}

export interface RecentInvestigation {
  at: string;
  headline: string;
  outcome: string; // e.g. "hold (watch X)" or "buy USDTBOB $5000"
}

export async function triage(
  item: NewsItem,
  heldSymbols: unknown[] = [],
  recent: RecentInvestigation[] = [],
  guardrail?: GuardrailRef | null,
): Promise<TriageVerdict> {
  // Only the event's own text is guard content; positions and our own
  // investigation log are trusted context. Off → byte-identical to before.
  const g = guardedCall(activeGuardrail(guardrail));
  const resp = await client.messages.create(
    g.body({
      model: config.triageModel,
      max_tokens: 600,
      system: config.worldModel ? TRIAGE_SYSTEM_WORLD : TRIAGE_SYSTEM,
      messages: [
        {
          role: "user" as const,
          content: JSON.stringify({
            source_family: item.source_family,
            published_at: item.published_at,
            headline: g.tag(item.headline),
            summary: g.tag(item.summary),
            tickers_hint: item.tickers_hint,
            held_positions: heldSymbols,
            recent_investigations: recent,
          }),
        },
      ],
    }),
    { headers: g.headers },
  );
  const priced = priceUsage(config.triageModel, resp.usage);
  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (g.active && messageIntervened(resp)) {
    const side = blockedSide(text) ?? "input";
    return {
      materiality: 0,
      event_type: "other",
      regions: [],
      touches_positions: false,
      hypotheses: [],
      rationale: `guardrail: the Bedrock guardrail blocked triage (${side}); treated as not material`,
      usage: priced.usage,
      cost_usd: priced.usd,
      model: config.triageModel,
      guardrail_intervened: side,
    };
  }
  const raw = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const parsed = JSON.parse(raw);
  return {
    materiality: Number(parsed.materiality ?? 0),
    event_type: String(parsed.event_type ?? "other"),
    regions: Array.isArray(parsed.regions) ? parsed.regions.map(String) : [],
    touches_positions: parsed.touches_positions === true,
    hypotheses: Array.isArray(parsed.hypotheses) ? parsed.hypotheses.map(String) : [],
    rationale: String(parsed.rationale ?? ""),
    usage: priced.usage,
    cost_usd: priced.usd,
    model: config.triageModel,
  };
}
