// SPDX-License-Identifier: MIT-0
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentRunIntervened, blockedSide, customHeadersEnv, type GuardrailRef } from "./guardrail.js";
import { activeGuardrail } from "./guardrail-runtime.js";
import { config } from "./config.js";
import { buildFinTools, type FinToolOptions } from "./tools.js";
import { investigatorSystem } from "./prompts.js";
import { putTranscript } from "./audit.js";
import { priceSdkResult, type NormalizedUsage } from "./pricing.js";
import { runDecisions } from "./run-decisions.js";
import type { NewsItem, TradeDecision } from "./types.js";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The agent has no clock of its own — without this it buys closed-market
 * instruments against days-old quotes (observed live: bought USO at 04:34 UTC
 * Monday against a 2.4-day-old quote; exec refused it). Approximate sessions,
 * ignores US holidays and DST drift; the 20-min staleness gate is the backstop.
 */
export function marketSessionContext(now = new Date()): string {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const usOpen = day >= 1 && day <= 5 && mins >= 13 * 60 + 30 && mins < 20 * 60;
  const fxOpen = !(
    day === 6 ||
    (day === 0 && mins < 22 * 60) ||
    (day === 5 && mins >= 22 * 60)
  );
  // CME Globex: Sun 22:00 UTC through Fri 21:00 UTC with a daily break 21:00-22:00 UTC.
  const futuresOpen =
    !(day === 6 || (day === 0 && mins < 22 * 60) || (day === 5 && mins >= 21 * 60)) &&
    !(mins >= 21 * 60 && mins < 22 * 60);
  return [
    `Current time: ${now.toISOString()} (${DAYS[day]}).`,
    `Sessions right now (approx): US equities/ETFs ${
      usOpen ? "OPEN" : "CLOSED (Mon-Fri ~13:30-20:00 UTC)"
    }; US futures (energy, metals, index, rates, FX) ${
      futuresOpen ? "OPEN" : "CLOSED (Sun 22:00 - Fri 21:00 UTC, daily break 21:00-22:00 UTC)"
    }; FX majors ${
      fxOpen ? "OPEN" : "CLOSED (Sun 22:00 - Fri 22:00 UTC)"
    }; international equities: their local exchange hours (the staleness gate decides); crypto, prediction markets, parallel USDT rates: always open.`,
    "Execution refuses quotes older than 20 minutes (resolve_instrument's ageSecs). If the " +
      "venue is closed, your order PARKS and retries when it opens (up to 24h) — set " +
      "limit_price to bound the gap you're willing to pay at the open. For time-sensitive " +
      "theses, prefer a venue that is open right now.",
  ].join("\n");
}

const BUILTIN_TOOLS_OFF = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit",
  "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite",
];

export interface InvestigateOptions {
  /** Event-time clock (replay). Defaults to wall time. */
  nowIso?: string;
  /** Replay: read_source refuses the event's live url (lookahead). */
  bench?: boolean;
  /** Replaces investigatorSystem(...) verbatim — a prompt variant under test (strategy.ts). */
  systemPrompt?: string;
  /**
   * Shallow-merged over the FinToolOptions this function already builds, so a
   * harness can inject e.g. an as-of resolver or a tape recorder without a new
   * parameter here each time.
   */
  toolOptions?: Partial<FinToolOptions>;
  /** Override config.maxTurns for this run. */
  maxTurns?: number;
  /** Override config.effort for this run (low | medium | high | xhigh | max). */
  effort?: string;
  /**
   * Bedrock guardrail for this run (guardrail.ts): undefined = V2_GUARDRAIL_ID /
   * V2_GUARDRAIL_VERSION, null = off. The bench's `guardrail` variant sets it;
   * every other variant leaves the configured value (unset on the bench).
   */
  guardrail?: GuardrailRef | null;
}

export interface InvestigationResult {
  /** One or more actions, in submission order; never empty (defaults to hold). */
  decisions: TradeDecision[];
  costUsd: number;
  numTurns: number;
  degraded: boolean;
  transcriptUri: string | null;
  finalText: string;
  /** The runtime/API failed before the agent finished; `decisions` is the default hold. */
  errored: boolean;
  /**
   * Main-loop token usage as the SDK reported it (input, output, cache write,
   * cache read); absent when the runtime died before producing a result.
   */
  usage?: NormalizedUsage;
  /** costUsd was priced at the fallback rate: config.masterModel matched no pricing row. */
  pricedWithFallback?: boolean;
  /**
   * The Bedrock guardrail blocked a model call in this run: the result text or
   * an assistant turn is exactly a blocked message. Distinct from `errored` and
   * from the stale-bundled-runtime failure (also a zero-confidence hold at $0,
   * but with no blocked message anywhere).
   */
  guardrailIntervened?: boolean;
  /**
   * Decisions submitted before the run errored or the guardrail intervened:
   * audited, never executed (run-decisions.ts). Absent when nothing was withheld.
   */
  withheld?: TradeDecision[];
}

/**
 * One bounded investigation (the paper's master-agent loop). `search` is the
 * compressed-observation function from websearch.ts, or null for degraded and
 * replay runs (replay disables search deliberately: the live web knows the
 * future of an archived event — lookahead bias).
 */
export async function investigate(
  item: NewsItem,
  hypotheses: string[],
  search: ((query: string) => Promise<string>) | null,
  transcriptId: string = item.id,
  bookContext?: string,
  opts: InvestigateOptions = {},
): Promise<InvestigationResult> {
  const guardrail = activeGuardrail(opts.guardrail);
  const { server, holder } = buildFinTools({
    search,
    guardrail,
    newsId: item.id,
    // read_source works with search off, which is the point: an EDGAR accession
    // is immutable, so the bench can read the filing without lookahead.
    source: { url: item.url, body_s3_uri: item.body_s3_uri },
    bench: opts.bench,
    ...(opts.toolOptions ?? {}),
  });
  const maxTurns = opts.maxTurns ?? config.maxTurns;
  const effort = opts.effort ?? config.effort;
  const transcript: unknown[] = [];
  const degraded = search === null;
  let costUsd = 0;
  let numTurns = 0;
  let finalText = "";
  let errored = false;
  let usage: NormalizedUsage | undefined;
  let pricedWithFallback = false;

  const prompt = [
    "Investigate this news event and submit one decision.",
    "",
    // Replay passes the event's own time: otherwise a week-old event reads as stale news.
    marketSessionContext(opts.nowIso ? new Date(opts.nowIso) : undefined),
    "",
    JSON.stringify(
      {
        id: item.id,
        source_family: item.source_family,
        published_at: item.published_at,
        headline: item.headline,
        summary: item.summary,
        url: item.url,
        tickers_hint: item.tickers_hint,
      },
      null,
      1,
    ),
    "",
    `Triage hypotheses (starting points, not conclusions): ${JSON.stringify(hypotheses)}`,
    ...(bookContext
      ? ["", "## Your current book and standing theses", bookContext]
      : []),
  ].join("\n");

  try {
    for await (const message of query({
      prompt,
      options: {
        model: config.masterModel,
        systemPrompt:
          opts.systemPrompt ?? investigatorSystem({ dryRun: config.dryRun, worldModel: config.worldModel }),
        maxTurns,
        maxBudgetUsd: config.maxBudgetPerRunUsd,
        ...(effort ? { effort: effort as NonNullable<typeof config.effort> } : {}),
        mcpServers: { fin: server },
        strictMcpConfig: true,
        settingSources: [],
        allowedTools: ["mcp__fin__*"],
        disallowedTools: BUILTIN_TOOLS_OFF,
        env: {
          ...process.env,
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_REGION: config.region,
          // The bundled runtime forwards these on every Bedrock request. It
          // cannot set the tagSuffix body field, so the guardrail evaluates the
          // whole input each turn (guardrail.ts, ops/README.md for the cost).
          ...(guardrail
            ? { ANTHROPIC_CUSTOM_HEADERS: customHeadersEnv(guardrail, process.env.ANTHROPIC_CUSTOM_HEADERS) }
            : {}),
        },
      },
    })) {
      transcript.push(message);
      const m = message as any;
      if (m.type === "result") {
        // The SDK prices what it knows; a Bedrock id it does not know reports
        // $0, so the tokens are priced at config.masterModel's rates (pricing.ts).
        const priced = priceSdkResult(m, config.masterModel);
        costUsd = priced.usd;
        usage = priced.usage;
        pricedWithFallback = priced.pricedWithFallback;
        numTurns = m.num_turns ?? 0;
        if (m.subtype === "success") finalText = m.result ?? "";
        else errored = true;
      }
    }
  } catch (e) {
    // query() throws after yielding an error result; cost was captured above.
    errored = true;
    console.error(`[investigate] errored for ${item.id}:`, e);
  }

  const transcriptUri = await putTranscript(transcriptId, transcript).catch((e) => {
    console.error("[investigate] transcript upload failed:", e);
    return null;
  });

  const guardrailIntervened = !!guardrail && agentRunIntervened(finalText, transcript);
  if (guardrailIntervened) {
    console.warn(`[guardrail] investigator blocked for ${item.id} (${blockedSide(finalText) ?? "mid-run"})`);
  }
  const { decisions, withheld } = runDecisions({
    submitted: holder.decisions,
    errored,
    guardrailIntervened,
    blockedSide: blockedSide(finalText),
    maxTurns,
  });
  if (withheld.length > 0) {
    console.warn(`[investigate] withheld ${withheld.length} decision(s) from a failed run for ${item.id}`);
  }
  return {
    decisions,
    costUsd,
    numTurns,
    degraded,
    transcriptUri,
    finalText,
    errored,
    usage,
    pricedWithFallback,
    ...(guardrailIntervened ? { guardrailIntervened } : {}),
    ...(withheld.length > 0 ? { withheld } : {}),
  };
}
