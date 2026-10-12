// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import { investigatorSystem } from "./prompts.js";
import type { NewsItem } from "./types.js";
import type { InvestigationResult, InvestigateOptions } from "./investigate.js";
import type { FinToolOptions } from "./tools.js";
import { guardrailRef, type GuardrailRef } from "./guardrail.js";

/**
 * The decision-layer seam: everything between "a triaged news item plus a book"
 * and "a list of TradeDecisions" is a Strategy, so the replay bench can run the
 * same tape through several prompts and structures and compare them. The live
 * investigator is one Strategy ("live"); the others are the variants under test.
 *
 * This module must stay free of AWS clients at import time: investigate.ts pulls
 * in S3/DynamoDB/SSM clients through audit/ledger/budget, so it is imported
 * lazily inside decide() and only its types are imported here. Tests inject
 * `investigateFn` and never touch the Agent SDK.
 */

export interface StrategyInput {
  item: NewsItem;
  hypotheses: string[];
  /** Rendered book context (what pipeline.ts buildBookContext / the bench book produce). */
  bookContext?: string;
  /** Event-time clock for replays. */
  nowIso?: string;
  bench?: boolean;
  transcriptId?: string;
  /** Passed through to investigate's toolOptions so the integrator can inject an as-of resolver and tape recording. */
  toolOptions?: Record<string, unknown>;
  /**
   * Grounded web search, or null/omitted for the degraded mode the bench runs in
   * (the live web knows the future of an archived event). Additive to the spec:
   * a strategy that can never search would be bench-only.
   */
  search?: ((query: string) => Promise<string>) | null;
}

export interface StrategyResult extends InvestigationResult {
  variant: string;
}

export interface Strategy {
  /** Stable name recorded on every decision row and bench summary. */
  name: string;
  /** Free-text description of what differs, printed in bench summaries. */
  description: string;
  decide(input: StrategyInput): Promise<StrategyResult>;
  /**
   * Optional admission rule the bench applies before `decide`: which of the
   * triaged events this variant would have investigated at all. Live, the
   * worker owns admission (flat or yield-aware); here a variant can test a
   * filter on the same tape as the others.
   */
  admit?: (ev: {
    item: NewsItem;
    materiality: number;
    eventType?: string;
    touchesPositions?: boolean;
  }) => { admitted: boolean; reason: string };
}

/** The shape of investigate(); injectable so tests never start the Agent SDK. */
export type InvestigateFn = (
  item: NewsItem,
  hypotheses: string[],
  search: ((query: string) => Promise<string>) | null,
  transcriptId: string,
  bookContext: string | undefined,
  opts: InvestigateOptions,
) => Promise<InvestigationResult>;

export interface AgentSdkStrategyOptions {
  name?: string;
  description?: string;
  /** Replaces investigatorSystem(...) verbatim. */
  systemPrompt?: string;
  maxTurns?: number;
  effort?: string;
  /** Rewrites the rendered book context before the agent sees it (e.g. strip the mandate block). */
  transformBookContext?: (ctx: string | undefined) => string | undefined;
  /** Bedrock guardrail for this variant's investigations (undefined = whatever config says). */
  guardrail?: GuardrailRef | null;
  /** Test seam: defaults to the real investigate(), loaded lazily. */
  investigateFn?: InvestigateFn;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The live investigator as a Strategy: exactly what investigate() does today. */
export function agentSdkStrategy(opts: AgentSdkStrategyOptions = {}): Strategy {
  const name = opts.name ?? "live";
  return {
    name,
    description:
      opts.description ??
      "the live investigator: investigatorSystem() prompt, config.maxTurns, config.effort, mandate in the book context",
    async decide(input: StrategyInput): Promise<StrategyResult> {
      const investigateFn: InvestigateFn =
        opts.investigateFn ?? (await import("./investigate.js")).investigate;
      const bookContext = opts.transformBookContext
        ? opts.transformBookContext(input.bookContext)
        : input.bookContext;
      const inv = await investigateFn(
        input.item,
        input.hypotheses,
        input.search ?? null,
        input.transcriptId ?? input.item.id,
        bookContext,
        defined({
          nowIso: input.nowIso,
          bench: input.bench,
          systemPrompt: opts.systemPrompt,
          maxTurns: opts.maxTurns,
          effort: opts.effort,
          guardrail: opts.guardrail,
          toolOptions: input.toolOptions as Partial<FinToolOptions> | undefined,
        }),
      );
      return { ...inv, variant: name };
    },
  };
}

// ---------------------------------------------------------------------------
// "no-mandate": the 2026-09-03 investigator, before the deployment mandate.
//
// The mandate is expressed in two places, so removing it takes two transforms:
//  1. prompts.ts carries the POLICY — "portfolio manager, not an analyst",
//     the conviction→size ladder, "already priced in describes the first move",
//     holds scored against you, "size down rather than sit out";
//  2. mandate.ts carries the NUMBERS, appended to every book context by
//     renderMandate(): equity, deployed % against the band, the ladder in
//     dollars, the watchlist.
// Each rewrite below restores the pre-mandate sentence from commit 37dbca2 (the
// prompt that produced 231 holds to 6 buys — the honest control). Anchors are
// exact and REQUIRED: if prompts.ts drifts, construction throws rather than
// silently benching the live prompt under a different name.
// ---------------------------------------------------------------------------

const MANDATE_PROMPT_REWRITES: Array<[anchor: string, replacement: string]> = [
  [
    "You are a portfolio manager, not an analyst: this book exists to be tested, and cash teaches nothing. When an event gives you a direction and a resolvable instrument, EXPRESS it — sized to conviction, small when unsure — rather than describing it. Hold only when you have no direction, no instrument resolves, or the move is complete and you have no view on the next 1–7 days; say which one.",
    "A lone hold is a first-class outcome; most events are already priced in or have no tradeable expression, and saying so crisply is a win.",
  ],
  [
    "every hold is scored as the counterfactual trade on that symbol, so a hold that would have made money counts against you exactly as a losing trade does.",
    "your holds are scored as counterfactuals, so restraint gets credit too.",
  ],
  [
    "- Size by conviction (confidence = your probability that the direction is right): 0.55 → about 1% of equity as a starter; 0.60–0.65 → 2–3%; 0.70 and above → 4–6%; never more than 10% of equity in one name, never more than ~25% of the visible book. The book context prints these as dollar figures at current equity, together with the deployment mandate and a watchlist of instruments you already considered. A starter position is how you learn: when direction is clear and magnitude is not, take 1% rather than hold.\n" +
      '- "Already priced in" describes the first move, not the next week. If the reaction has happened, decide whether you have a view on the follow-through — continuation, fade, or none — and act on it; only "none" is a hold. A hold\'s confidence is your confidence that NO trade here has positive expectation; reserve 0.8 and above for cases you can defend line by line.\n' +
      "- There is no risk gate reviewing you. That is deliberate — this experiment measures YOUR unassisted judgment — sizing included, and including the judgment to stay out when you can say exactly why.",
    "- Choose notional_usd yourself, sized to conviction; state why.\n" +
      "- There is no risk gate reviewing you. That is deliberate — this experiment measures YOUR unassisted judgment, including restraint.",
  ],
  [
    "If web search tools are unavailable this session, say so in your rationale, lean on read_source and the event itself, and size down rather than sit out when the instrument and mechanism are clear.",
    "If web search tools are unavailable this session, note that in your rationale, lean on read_source and the event itself, and prefer hold unless the instrument and mechanism are obvious from the event alone.",
  ],
];

/** The live system prompt with the deployment-mandate policy replaced by the pre-mandate wording. Throws when an anchor is missing. */
export function stripMandateFromPrompt(prompt: string): string {
  let out = prompt;
  for (const [anchor, replacement] of MANDATE_PROMPT_REWRITES) {
    if (!out.includes(anchor)) {
      throw new Error(
        `no-mandate: anchor not found in investigatorSystem(): "${anchor.slice(0, 70)}…" — ` +
          "prompts.ts changed; update MANDATE_PROMPT_REWRITES in strategy.ts",
      );
    }
    out = out.replace(anchor, replacement);
  }
  return out;
}

/**
 * Removes the renderMandate() block from a rendered book context: the
 * "Mandate (deployment):" line, its Status / Conviction lines, and the
 * watchlist (header plus "- SYMBOL (...)" items). Everything else — the book
 * JSON, standing theses, world model, pending orders — is kept.
 */
export function stripMandateFromBookContext(ctx: string | undefined): string | undefined {
  if (!ctx) return ctx;
  const lines = ctx.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Mandate (deployment):"));
  if (start < 0) return ctx;
  let end = start + 1;
  let inWatchlist = false;
  while (end < lines.length) {
    const l = lines[end];
    if (l.startsWith("Status:") || l.startsWith("Conviction → ")) {
      end++;
    } else if (l.startsWith("Watchlist")) {
      inWatchlist = true;
      end++;
    } else if (inWatchlist && l.startsWith("- ")) {
      end++;
    } else {
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function noMandateStrategy(): Strategy {
  return agentSdkStrategy({
    name: "no-mandate",
    description:
      "the 2026-09-03 investigator: live prompt with the deployment-mandate policy replaced by the " +
      "pre-mandate wording (lone hold is first-class, restraint gets credit, choose notional yourself) " +
      "AND the renderMandate() block stripped from the book context. Same tools, turns and effort.",
    systemPrompt: stripMandateFromPrompt(
      investigatorSystem({ dryRun: config.dryRun, worldModel: config.worldModel }),
    ),
    transformBookContext: stripMandateFromBookContext,
  });
}

/** Registry. "live" is the control; each variant differs in exactly what its description says. */
export const VARIANTS: Record<string, () => Strategy> = {
  live: () => agentSdkStrategy(),
  // The live investigator behind a yield-aware admission bar (yield-data.ts),
  // computed from this arm's own history as of the window start; replay.ts
  // attaches the rule because the table needs an AWS read.
  "yield-triage": () =>
    agentSdkStrategy({
      name: "yield-triage",
      description: "live investigator; events admitted by the yield table as of the window start (V2_YIELD_TRIAGE)",
    }),
  "no-mandate": noMandateStrategy,
  // Threat model M02 control: the live prompt WITHOUT contentIsDataSection(),
  // i.e. the prompt before 2026-10-01, when only web_search results were data.
  "no-content-rule": () =>
    agentSdkStrategy({
      name: "no-content-rule",
      description:
        "live prompt without the external-content-is-data section (prompts.ts contentIsDataSection), " +
        "the pre-2026-10-01 prompt: only web_search observations are flagged as data",
      systemPrompt: investigatorSystem({
        dryRun: config.dryRun,
        worldModel: config.worldModel,
        contentIsData: false,
      }),
    }),
  terse: () =>
    agentSdkStrategy({
      name: "terse",
      description:
        "live prompt and book context, maxTurns 6 instead of config.maxTurns: a structural knob — " +
        "does a shorter leash change what gets traded, or only what gets read?",
      maxTurns: 6,
    }),
  guardrail: () => guardrailStrategy(),
};

/**
 * The live investigator behind the Bedrock guardrail (guardrail.ts): the
 * investigator names it on every request and read_source output passes
 * ApplyGuardrail (web search is off on the bench). Triage is shared by every
 * variant and stays unguarded unless V2_GUARDRAIL_ID is set for the whole
 * process, so the guardrail is the only difference from `live`. The guardrail
 * comes from V2_BENCH_GUARDRAIL_ID / V2_BENCH_GUARDRAIL_VERSION, which replay.ts
 * sets from --guardrail-id / --guardrail-version.
 */
export function guardrailStrategy(env: NodeJS.ProcessEnv = process.env): Strategy {
  const g = guardrailRef(env.V2_BENCH_GUARDRAIL_ID, env.V2_BENCH_GUARDRAIL_VERSION);
  if (!g) {
    throw new Error(
      'variant "guardrail" needs a guardrail: pass --guardrail-id <id> --guardrail-version <n> ' +
        "(FinStack outputs GuardrailId / GuardrailVersion), or set V2_BENCH_GUARDRAIL_ID and V2_BENCH_GUARDRAIL_VERSION",
    );
  }
  return agentSdkStrategy({
    name: "guardrail",
    description:
      `live investigator behind Bedrock guardrail ${g.id} v${g.version}: request headers on every ` +
      "investigator call (whole input evaluated) and ApplyGuardrail over read_source output",
    guardrail: g,
  });
}

export function getStrategy(name: string): Strategy {
  if (!Object.prototype.hasOwnProperty.call(VARIANTS, name)) {
    throw new Error(
      `unknown strategy "${name}"; known variants: ${Object.keys(VARIANTS).join(", ")}`,
    );
  }
  return VARIANTS[name]();
}

/** Parse "--variants a,b,c" style input; default ["live"]. Pure. */
export function parseVariantList(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out.length > 0 ? out : ["live"];
}
