// SPDX-License-Identifier: MIT-0
import { loadArms, resolveArmDefaults } from "./arms.js";

/**
 * The arms registry (arms.json at the repo root, or V2_ARMS_FILE) and this
 * process's arm: V2_ARM selects it (default: the first agent arm, v2 in the
 * shipped file). Every arm-specific default below — table, tape table, SSM
 * params, master model, effort, world model, investigation cap — comes from the
 * arm's entry through the pure precedence rule in arms.ts, and an explicit
 * V2_* variable always wins, so the private launchd plists keep working
 * unchanged. Read arms.ts before adding an arm-dependent knob.
 */
export const arms = loadArms();
const armDefaults = resolveArmDefaults(process.env, arms);

export const config = {
  region: process.env.AWS_REGION ?? "us-east-1",
  /** Resource-name prefix shared by every arm (arms.json `prefix`). */
  prefix: arms.prefix,
  table: armDefaults.table,
  /**
   * Quote tape (tape.ts), shared by both arms: every price the system observes,
   * stamped when it was observed, so the replay bench can price instruments
   * as-of an archived event instead of with live quotes. Logged 2026-09-04.
   */
  tapeTable: armDefaults.tapeTable,
  queueUrl: process.env.V2_QUEUE_URL ?? "",
  /** This arm's news queue NAME (from the registry); the worker still needs the URL in V2_QUEUE_URL. */
  newsQueue: armDefaults.newsQueue,
  /** S3 bucket for full agent transcripts (FinStack output V2TranscriptsBucket). */
  transcriptBucket: process.env.V2_TRANSCRIPT_BUCKET ?? "",
  killSwitchParam: armDefaults.killSwitchParam,
  dailyBudgetParam: armDefaults.dailyBudgetParam,

  /** Phase A default: decide but don't fill. Flip with V2_DRY_RUN=false. */
  dryRun: (process.env.V2_DRY_RUN ?? "true").toLowerCase() !== "false",

  triageModel:
    process.env.V2_TRIAGE_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  /** The investigator's model: V2_MASTER_MODEL, else the arm's `model` in arms.json. */
  masterModel: armDefaults.masterModel,

  // 0.55 → 0.45 on 2026-09-04: widens the funnel by ~2 investigations/day (the
  // scorer puts 94% of items under 0.35), at ~$0.40 each against a $100 budget.
  triageThreshold: Number(process.env.V2_TRIAGE_THRESHOLD ?? "0.45"),
  /** Lower bar for news that touches an instrument we hold. */
  heldTriageThreshold: Number(process.env.V2_HELD_TRIAGE_THRESHOLD ?? "0.35"),
  /**
   * Yield-aware triage (2026-09-19). Three weeks of v2 scores showed the flat
   * bar spending 42% of the budget on position alerts at a 43% hit rate and
   * triaging disasters at the highest median materiality (0.72) while 2% of them
   * produced a decision, whereas EDGAR corporate and macro items returned about
   * $10 and $35 of paper P&L per LLM dollar. With V2_YIELD_TRIAGE=on the worker
   * reads STATE/YIELD (written daily by `npm run yield -- --write`) and moves
   * each category's bar between floor and ceil around triageThreshold by its
   * shrunk P&L per dollar; an exploration floor keeps every category sampled;
   * news touching a held symbol keeps heldTriageThreshold regardless. Off by
   * default because it changes what the agent sees: validate on the bench
   * (variant `yield-triage`) before turning it on. Method: yield-data.ts.
   */
  yieldTriage: {
    enabled: (process.env.V2_YIELD_TRIAGE ?? "").toLowerCase() === "on",
    halfLifeDays: Number(process.env.V2_YIELD_HALF_LIFE_DAYS ?? "7"),
    minN: Number(process.env.V2_YIELD_MIN_N ?? "20"),
    maturityDays: Number(process.env.V2_YIELD_MATURITY_DAYS ?? "8"),
    maxShift: Number(process.env.V2_YIELD_MAX_SHIFT ?? "0.20"),
    floor: Number(process.env.V2_YIELD_FLOOR ?? "0.30"),
    ceil: Number(process.env.V2_YIELD_CEIL ?? "0.80"),
    explorationPerDay: Number(process.env.V2_YIELD_EXPLORATION_PER_DAY ?? "3"),
    refreshMinutes: Number(process.env.V2_YIELD_REFRESH_MIN ?? "60"),
  },
  /** Position watcher: a new leg of this size triggers a re-evaluation. */
  watchMovePct: Number(process.env.V2_WATCH_MOVE_PCT ?? "5"),
  watchMovePredictionPct: Number(process.env.V2_WATCH_MOVE_PREDICTION_PCT ?? "10"),
  watchCooldownHours: Number(process.env.V2_WATCH_COOLDOWN_HOURS ?? "4"),
  /**
   * A price move on a book too thin to transact against is not an event worth an
   * investigation: on a $16-deep contract the bid ticking 0.13 -> 0.10 is one
   * order disappearing. Alerts need this much resting depth (when the venue
   * reports it) and a spread no wider than this fraction of the mid.
   */
  watchMinDepthUsd: Number(process.env.V2_WATCH_MIN_DEPTH_USD ?? "500"),
  watchMaxSpreadFrac: Number(process.env.V2_WATCH_MAX_SPREAD_FRAC ?? "0.25"),
  /** Defer the daily review while every position was re-underwritten this recently... */
  reviewSkipIfFreshMin: Number(process.env.V2_REVIEW_SKIP_IF_FRESH_MIN ?? "60"),
  /** ...but never past this many hours after the review hour. */
  reviewGraceHours: Number(process.env.V2_REVIEW_GRACE_HOURS ?? "3"),
  /**
   * FX majors trade on an interbank market measured in fractions of a basis
   * point; Kraken's fiat book (our only FX venue with bid/ask) can be 200 bps
   * wide. Above this spread the book is not the market: use the reference rate.
   */
  fxMaxSpreadBps: Number(process.env.V2_FX_MAX_SPREAD_BPS ?? "10"),
  /** Daily whole-book review fires at this UTC hour. */
  reviewHourUtc: Number(process.env.V2_REVIEW_HOUR_UTC ?? "13"),
  /** Parked (at-open / limit) orders expire after this many hours. */
  pendingExpiryHours: Number(process.env.V2_PENDING_EXPIRY_HOURS ?? "24"),
  /**
   * A liquidity-capped fill that REDUCES a position parks its remainder as a
   * working order; the watcher takes another slice (25% of the then-visible
   * book) no sooner than this many minutes after the last one. 2026-09-08: the
   * daily review decided to exit two hurricane contracts, asked to sell $7,107,
   * filled $43 (books of $45 and $129) and the rest was silently dropped — the
   * second time in three days. Pacing matters because paper fills do not consume
   * the real book: unpaced, the 5-minute watch pass would take $11 from a $45
   * book 288 times a day.
   */
  pendingSliceMinutes: Number(process.env.V2_PENDING_SLICE_MIN ?? "60"),
  /**
   * News investigations stop at (1 - reserve) of the daily budget; position
   * management (alerts, daily review) may spend the reserve. News spam must
   * never starve the agent's ability to manage what it already holds.
   */
  budgetReserveFraction: Number(process.env.V2_BUDGET_RESERVE_FRACTION ?? "0.2"),
  /** Identical headlines within this window are skipped before triage. */
  dedupeHours: Number(process.env.V2_DEDUPE_HOURS ?? "3"),
  /**
   * Liquidity realism: a paper fill may take at most this fraction of the
   * venue's resting book (prediction markets report it). Market physics,
   * not a risk gate — a $16 book cannot absorb a $2,000 order.
   */
  maxFillLiquidityFraction: Number(process.env.V2_MAX_FILL_LIQUIDITY_FRACTION ?? "0.25"),
  maxNewsAgeHours: Number(process.env.V2_MAX_NEWS_AGE_HOURS ?? "6"),
  maxTurns: Number(process.env.V2_MAX_TURNS ?? "15"),
  /**
   * Reasoning effort for the investigator (Agent SDK `effort`): low | medium | high |
   * xhigh | max. V2_EFFORT, else the arm's `effort` in arms.json; unset/null = the SDK
   * default (high). Thinking itself is always on for Fable 5.1 (adaptive); this is the
   * depth knob.
   */
  effort: armDefaults.effort,
  maxBudgetPerRunUsd: Number(process.env.V2_MAX_BUDGET_PER_RUN_USD ?? "3"),
  /** V2_MAX_INVESTIGATIONS_PER_DAY, else the arm's `maxInvestigationsPerDay`, else 20. */
  maxInvestigationsPerDay: armDefaults.maxInvestigationsPerDay,
  maxQuoteAgeSecs: 20 * 60,

  /**
   * Which arm this process is (V2_ARM; default the registry's first agent arm).
   * The unassisted control and the world-model arm run the same code with
   * their own table/queue/budget so they can be compared on the same news.
   * Used for log and transcript prefixes and for snapshot keys.
   */
  arm: armDefaults.arm,
  /** The arm's human label from arms.json (report, dashboard, letter). */
  armLabel: armDefaults.label,
  /**
   * Typed, gated world model shared across investigations + the curiosity loop.
   * V2_WORLD_MODEL=1|0 wins, else the arm's `worldModel` in arms.json.
   */
  worldModel: armDefaults.worldModel,
  curiosityIntervalMin: Number(process.env.V2_CURIOSITY_INTERVAL_MIN ?? "60"),
  curiosityCooldownHours: Number(process.env.V2_CURIOSITY_COOLDOWN_HOURS ?? "6"),

  /**
   * When this arm's paper account went live. Anchors return-since-inception
   * and the benchmark window, and may deliberately be EARLIER than the first
   * fill: time spent in cash is part of the agent's performance. The stored
   * value is the STATE/INCEPTION row `seed.ts` writes into the arm's table;
   * this is only the V2_INCEPTION override (undefined when unset), and readers
   * fall back to the row, then to the first fill.
   */
  inceptionIso: armDefaults.inceptionIso,

  /**
   * SEC fair-access policy requires an identifying User-Agent with contact info
   * on every EDGAR request (`read_source` fetches filings by accession). Same
   * value the stack passes v1's poller as EDGAR_CONTACT.
   */
  edgarContact: process.env.V2_EDGAR_CONTACT ?? process.env.EDGAR_CONTACT ?? "",

  /**
   * Amazon Bedrock guardrail id (FinStack output GuardrailId); set it together with
   * V2_GUARDRAIL_VERSION, or leave both unset for no guardrail (the default, and how the
   * live control arms run). When set, triage, filing summaries and the v3 link judge send
   * only the untrusted text as guard content, the investigator names the guardrail in
   * every request (Bedrock then evaluates its whole input each turn, which is what the
   * bill counts), and read_source / web_search output passes ApplyGuardrail before the
   * agent reads it (fail-open). guardrail.ts has the details; ops/README.md how to turn
   * it on after a bench. Added 2026-10-02 (threat model: prompt injection, beyond M02).
   */
  guardrailId: process.env.V2_GUARDRAIL_ID ?? "",
  /** Published guardrail version (FinStack output GuardrailVersion), never DRAFT in production. */
  guardrailVersion: process.env.V2_GUARDRAIL_VERSION ?? "",
  /**
   * Per-call bound on one ApplyGuardrail screen of a tool result, in ms. On a timeout or
   * any error the result passes unscreened (fail-open: availability over screening; the
   * external-content-is-data rule in the investigator prompt is the primary control).
   */
  guardrailScreenTimeoutMs: Number(process.env.V2_GUARDRAIL_SCREEN_TIMEOUT_MS ?? "8000"),

  /**
   * The deployment mandate printed into every book context (mandate.ts): the
   * band the book should sit in, the position cap, and how far back the
   * watchlist reaches. Added 2026-09-04 after five days of 231 holds to 6 buys.
   */
  mandate: {
    minDeployedPct: Number(process.env.V2_MANDATE_MIN_DEPLOYED ?? "0.30"),
    maxDeployedPct: Number(process.env.V2_MANDATE_MAX_DEPLOYED ?? "0.70"),
    minPositions: 4,
    maxPositions: 12,
    maxPositionPct: Number(process.env.V2_MANDATE_MAX_POSITION ?? "0.10"),
    watchlistHours: Number(process.env.V2_MANDATE_WATCHLIST_HOURS ?? "72"),
  },

  /**
   * Web search backend for the investigator: "nova" (Amazon Nova web grounding
   * on Bedrock — AWS credentials only) or "off" (degraded mode). An earlier
   * MCP search client that needed separate SSO was retired 2026-09-04; see websearch.ts.
   */
  webSearch: process.env.V2_WEB_SEARCH ?? "nova",
  /**
   * Opt-in data sources (sources.ts), comma-separated: `yahoo`, `kalshi`,
   * `coinbase`, `polymarket`. Off by default since 2026-10-07: their terms do not
   * permit this use without the deployer's own permission, or could not be
   * reviewed (docs/THIRD_PARTY_NOTICES.md). A disabled source
   * makes no network call and the resolver reports it as not enabled.
   */
  enableSources: process.env.V2_ENABLE_SOURCES ?? "",
  /** Grounding is US-CRIS-only, hence the `us.` inference profile. */
  searchModel: process.env.V2_SEARCH_MODEL ?? "us.amazon.nova-2-lite-v1:0",
  /** One grounded call ran 10 s in the 2026-09-04 probe; a request may run several searches. */
  searchTimeoutMs: Number(process.env.V2_SEARCH_TIMEOUT_MS ?? "60000"),
  /**
   * Nova 2 Lite, us-east-1 on-demand list prices from the AWS Pricing API on
   * 2026-09-04 (usagetypes USE1-Nova2.0Lite-{input,output}-tokens and
   * USE1-Nova2.0Lite-nova-grounding, the last billed per request however many
   * searches the model runs inside it).
   */
  nova: { inputPerMTok: 0.33, outputPerMTok: 2.75, groundingPerRequest: 0.03 },

  /**
   * Reasoning effort for the daily letter's narrative (Fable 5.1 `output_config.effort`:
   * low | medium | high | xhigh | max; unset = the API default, high). Thinking is always
   * on for Fable 5.1 and spends from max_tokens: on 2026-09-05 the 08:00 letter spent all
   * 16,000 output tokens thinking and wrote 0 characters (stop_reason max_tokens), so the
   * ceiling is now 64,000 and an empty narrative retries at "medium".
   */
  letterEffort: (process.env.V2_LETTER_EFFORT || undefined) as
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | undefined,

  /** Fable 5.1 first-party rates, used when the SDK can't price the Bedrock model. */
  fable: { inputPerMTok: 10, outputPerMTok: 50 },

  /**
   * Per-model pricing (pricing.ts). Every model call reports token usage; the
   * rate table turns it into dollars for the budget breaker, the decision and
   * triage audit rows, and the letter. The defaults are list prices as of
   * 2026-09-11 and a default to override, not a source of truth: a JSON object
   * of model-id substring -> {input, output, cacheWrite?, cacheRead?} in USD per
   * million tokens, merged over the built-in rows. A model that matches no row
   * is priced at a deliberately expensive fallback and every figure derived
   * from it is flagged `priced_with_fallback`.
   */
  modelRatesJson: process.env.V2_MODEL_RATES_JSON ?? "",
  /**
   * Meter Haiku triage and filing enrichment into the daily spend breaker.
   * Off by default: since inception the private arms' SPEND rows have counted
   * investigations (and their grounded searches) only, and the letter says so;
   * turning this on adds roughly a cent per triaged item to cost_usd (tallied
   * separately as triage_cost_usd so the old series can be recovered). The
   * bench meters always, under its own BENCH# scope.
   */
  meterTriage: ["1", "true"].includes((process.env.V2_METER_TRIAGE ?? "").trim().toLowerCase()),
};

export function requireConfig(keys: ("queueUrl" | "transcriptBucket")[]): void {
  for (const k of keys) {
    if (!config[k]) {
      const env = k === "queueUrl" ? "V2_QUEUE_URL" : "V2_TRANSCRIPT_BUCKET";
      throw new Error(`${env} must be set (see FinStack outputs)`);
    }
  }
}
