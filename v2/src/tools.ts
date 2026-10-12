// SPDX-License-Identifier: MIT-0
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolve } from "./quotes/resolver.js";
import { searchMarkets } from "./quotes/prediction.js";
import * as ledger from "./ledger.js";
import { getThesis } from "./thesis.js";
import { config } from "./config.js";
import { worldModelFor, NODE_TYPES, RELATIONS, type NodeType, type Relation } from "./world.js";
import { proposeFact, proposeLink } from "./worldwrite.js";
import { readSource } from "./source.js";
import { recordResolution, recordMarkets, quoteAsOf, marketsAsOf } from "./tape.js";
import { resolveAsOf, type AsOfDeps } from "./quotes/asof.js";
import type { NewsItem, TradeDecision } from "./types.js";
import type { GuardrailRef } from "./guardrail.js";
import { screenToolOutput, type ApplyFn } from "./guardrail-runtime.js";

const KINDS = ["auto", "fx", "parallel_fx", "equity", "crypto", "prediction"] as const;

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export interface DecisionHolder {
  decisions: TradeDecision[];
}

/**
 * What the portfolio tools read. Live, this is the DynamoDB ledger + thesis table;
 * in a bench it is the simulated book (bench/book.ts) plus that run's own prior
 * decisions — the live THESIS# rows contain rationales written AFTER an archived
 * event, so reading them during a replay would be lookahead.
 */
export interface BookView {
  getPortfolio(): Promise<{ cash: number; realized_pnl_today: number; day_key: string } | null>;
  listPositions(): Promise<
    Array<{ symbol: string; qty: number; avg_cost: number; kind?: string; last_watch_price?: number }>
  >;
  recentTrades(symbol: string, limit: number): Promise<unknown[]>;
  decisionHistory(symbol: string): Promise<unknown | null>;
}

export interface FinToolOptions {
  /** Grounded-observation search (websearch.ts), or null in degraded/replay mode. */
  search: ((query: string) => Promise<string>) | null;
  /** The event being investigated; world-model proposals are audited under it. */
  newsId?: string;
  /** What read_source reads: the event's own url and archived body. */
  source?: Pick<NewsItem, "url" | "body_s3_uri">;
  /** Replay: read_source refuses sources the publisher rewrites in place. */
  bench?: boolean;
  /**
   * Bench: resolve_instrument and search_markets answer AS OF this instant (epoch
   * ms) from the quote tape, then Yahoo history (quotes/asof.ts) — never a live
   * quote, so an archived event cannot see a price that already contains its outcome.
   */
  asOfMs?: number;
  /** Bench: portfolio and decision-history tools read this instead of the live ledger. */
  book?: BookView;
  /** Test seam for the as-of resolver (inject a fake tape / bars). Defaults to the real tape. */
  asOfDeps?: AsOfDeps;
  /**
   * Bedrock guardrail for read_source and web_search output (ApplyGuardrail,
   * guardrail-runtime.ts). investigate() always passes its resolved choice;
   * absent or null = no screening.
   */
  guardrail?: GuardrailRef | null;
  /** Test seam for the ApplyGuardrail call. */
  guardrailApply?: ApplyFn;
}

// The SDK's tool() helper cannot convert z.record / z.union to JSON schema (tools/list
// then throws and the agent sees NO fin tools at all — observed 2026-09-02). Objects and
// mixed values therefore travel as strings and are parsed here.
function parseProps(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
function parseValue(raw: string): number | string {
  const t = raw.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
}

const NODE_TYPE = z.enum([...NODE_TYPES] as [NodeType, ...NodeType[]]);
const RELATION = z.enum([...RELATIONS] as [Relation, ...Relation[]]);

/** v3 only: read and (through the gate) write the shared world model. */
function worldModelTools(opts: FinToolOptions) {
  return [
    tool(
      "get_world_model",
      "What the shared world model knows about instruments: facts (with source, time, STALE flag), " +
        "and exposure links to their drivers (storms with basin and position, regions, commodities, " +
        "indicators, issuers) with the causal mechanism and sign. Omit symbols for the held book.",
      { symbols: z.array(z.string()).optional() },
      async ({ symbols }) => {
        const syms = symbols && symbols.length > 0 ? symbols : (await ledger.listPositions()).map((p) => p.symbol);
        return text(await worldModelFor(syms));
      },
    ),
    tool(
      "record_fact",
      "Record a durable fact about an entity: a price level with its source and time, a storm's " +
        "position/intensity, a contract's resolution rule, an indicator print. Creates the entity if " +
        "you supply label (and props: storms need numeric lat/lon; landfall contracts should carry " +
        "region, e.g. 'texas'; commodities may carry quote_symbol). GATED: instruments must resolve; " +
        "price/level facts are checked against the live quote (a WTI fact that is really Brent is " +
        "rejected with the live value). The verdict tells you why.",
      {
        subject_type: NODE_TYPE,
        subject_id: z.string().describe("resolver symbol for instruments/contracts; a short name otherwise"),
        label: z.string().optional(),
        props: z.string().optional().describe('JSON object as a string, e.g. {"lat": 18.9, "lon": -133.8, "category": 5}'),
        key: z.string().describe("e.g. price, category, wind_mph, resolution_rule, position"),
        value: z.string().describe("the value; plain digits for numbers (e.g. 90.76), text otherwise"),
        unit: z.string().optional(),
        as_of: z.string().optional().describe("ISO time the fact was true; defaults to now"),
        source: z.string(),
        confidence: z.number().min(0).max(1),
        expires_hours: z.number().positive().optional(),
      },
      async (a) => text(await proposeFact({ ...a, props: parseProps(a.props), value: parseValue(a.value) } as any, opts.newsId)),
    ),
    tool(
      "link_exposure",
      "Link an instrument to what moves it (relation exposure, sign +1/-1/0 = driver up helps/hurts/" +
        "unsigned), or state structure: threatens (storm→region), resolves_on (contract→commodity or " +
        "instrument), tracks (ETF→commodity), issued_by (instrument→issuer), located_in (storm→region). " +
        "Spell out the causal mechanism in a sentence. GATED: a storm can only threaten or expose " +
        "contracts in its own basin; causal links are judged for directness (shared geography, sector " +
        "or theme is rejected). Do not trade on a link the gate rejected.",
      {
        from_type: NODE_TYPE.optional().describe("defaults to instrument, or contract for <slug>:YES symbols"),
        from_id: z.string(),
        from_label: z.string().optional(),
        from_props: z.string().optional().describe("JSON object as a string (e.g. region for a landfall contract)"),
        relation: RELATION.optional().describe("defaults to exposure"),
        to_type: NODE_TYPE,
        to_id: z.string(),
        to_label: z.string().optional(),
        to_props: z.string().optional().describe('JSON object as a string; storms need {"lat": ..., "lon": ...}'),
        sign: z.number().int().min(-1).max(1),
        mechanism: z.string(),
        source: z.string(),
        confidence: z.number().min(0).max(1),
        expires_hours: z.number().positive().optional(),
      },
      async (a) => text(await proposeLink({ ...a, from_props: parseProps(a.from_props), to_props: parseProps(a.to_props) } as any, opts.newsId)),
    ),
  ];
}

/**
 * In-process MCP server. resolve_instrument is the deterministic grounding
 * layer: it is the only path from "instrument the agent imagined" to
 * "instrument that exists with a live price". web_search returns a grounded,
 * cited observation (Nova web grounding), never raw pages (perception/reasoning split).
 */
export function buildFinTools(opts: FinToolOptions): {
  server: ReturnType<typeof createSdkMcpServer>;
  holder: DecisionHolder;
} {
  const holder: DecisionHolder = { decisions: [] };

  const server = createSdkMcpServer({
    name: "fin",
    version: "0.1.0",
    tools: [
      ...(config.worldModel ? worldModelTools(opts) : []),
      tool(
        "read_source",
        "Read the primary document this event refers to — the SEC filing itself, or the " +
          "archived full text of the article. Use it FIRST on any filing: the event's " +
          "summary is often only metadata (form type, item codes, accession number, byte " +
          "size) and web search does not index a filing minutes old. Returns the filing " +
          "text and any press-release exhibit, and lists the exhibits it did not read.",
        {},
        async () => {
          if (!opts.source || (!opts.source.url && !opts.source.body_s3_uri)) {
            return text({ error: "this event carries no source document" });
          }
          try {
            const fetched = await readSource(opts.source, { bench: opts.bench });
            if ("error" in fetched || !opts.guardrail) return text(fetched);
            const screened = await screenToolOutput("read_source", fetched.text, opts.guardrail, {
              apply: opts.guardrailApply,
            });
            if (screened.intervened) return text({ error: screened.text, withheld_by_guardrail: true });
            return text({ ...fetched, text: screened.text });
          } catch (e) {
            return text({ error: `read_source failed: ${String(e)}` });
          }
        },
      ),
      tool(
        "web_search",
        "Search the web. Returns a short grounded observation (facts, numbers, dates, " +
          "whether the market already reacted) with the source URLs it was drawn from — " +
          "not raw pages. One specific question per call.",
        { query: z.string().describe("Search query") },
        async ({ query }) => {
          if (!opts.search) {
            return text({
              error: "web search unavailable this session (degraded mode)",
            });
          }
          try {
            const observation = await opts.search(query);
            const screened = await screenToolOutput("web_search", observation, opts.guardrail ?? null, {
              apply: opts.guardrailApply,
            });
            return { content: [{ type: "text" as const, text: screened.text }] };
          } catch (e) {
            return text({ error: `search failed: ${String(e)}` });
          }
        },
      ),
      tool(
        "resolve_instrument",
        "Resolve a candidate instrument to a live quote, or learn it is untradeable. " +
          "Symbols: FX pairs as 6-letter ISO pairs (USDJPY); parallel rates as USDT+fiat " +
          "(USDTBOB); equities/ETFs/ADRs as tickers (ARGT), international listings with the " +
          "exchange suffix (7203.T, VOD.L), futures as Yahoo symbols (CL=F, ES=F, ZN=F); crypto as " +
          "base symbols (BTC; pass kind=crypto for coins that are also equity tickers, e.g. OM); prediction markets as <ticker-or-slug>:YES|NO. Returns price, bid/ask when a " +
          "book exists, quote age, source, indicativeOnly (reference rate, no book), " +
          "liquidityUsd (resting book depth — fills are capped to ~25% of it) and " +
          "resolved=true when a prediction market has already paid out.",
        {
          symbol: z.string().describe("Candidate symbol"),
          kind: z.enum(KINDS).optional().describe("Instrument kind; omit to auto-detect"),
        },
        async ({ symbol, kind }) => {
          if (opts.asOfMs !== undefined) {
            return text(
              await resolveAsOf(symbol, kind ?? "auto", opts.asOfMs, { tape: quoteAsOf, ...opts.asOfDeps }),
            );
          }
          const res = await resolve(symbol, kind ?? "auto");
          // Every price the agent sees goes on the tape (tape.ts) so the bench can
          // later resolve as-of the event. Never in a bench: those are replays.
          if (!opts.bench) void recordResolution(res, { newsId: opts.newsId, origin: "tool" });
          return text(res);
        },
      ),
      tool(
        "search_markets",
        "Free-text search of Polymarket prediction markets. Returns tradeable symbols " +
          "(<slug>:YES), the question, current YES price, and volume.",
        { query: z.string(), limit: z.number().int().min(1).max(10).optional() },
        async ({ query, limit }) => {
          if (opts.asOfMs !== undefined) {
            // Only markets someone saw at or before the event: closed markets vanish live.
            return text(await marketsAsOf(query, opts.asOfMs, { limit: limit ?? 8 }));
          }
          const hits = await searchMarkets(query, limit ?? 8);
          if (!opts.bench) void recordMarkets(hits, { newsId: opts.newsId });
          return text(hits);
        },
      ),
      tool(
        "get_portfolio",
        "Paper portfolio snapshot: cash (USD) and realized P&L today.",
        {},
        async () => text(await (opts.book ? opts.book.getPortfolio() : ledger.getPortfolio())),
      ),
      tool(
        "get_positions",
        "All open paper positions: symbol, qty, average cost.",
        {},
        async () => text(await (opts.book ? opts.book.listPositions() : ledger.listPositions())),
      ),
      tool(
        "get_recent_trades",
        "Recent fills for one symbol, newest first.",
        { symbol: z.string(), limit: z.number().int().min(1).max(50).optional() },
        async ({ symbol, limit }) =>
          text(
            await (opts.book
              ? opts.book.recentTrades(symbol, limit ?? 20)
              : ledger.recentTrades(symbol, limit ?? 20)),
          ),
      ),
      tool(
        "get_decision_history",
        "Past decisions and rationales for one symbol (the standing thesis plus up " +
          "to 8 prior entries) — how your predecessors reasoned about this instrument.",
        { symbol: z.string() },
        async ({ symbol }) =>
          text(
            (await (opts.book ? opts.book.decisionHistory(symbol) : getThesis(symbol))) ?? {
              note: `no prior decisions for ${symbol}`,
            },
          ),
      ),
      tool(
        "submit_decision",
        "Submit one action; call once per action, as many times as the situation " +
          "warrants (rotations, multi-leg expressions, several exits). Actions execute " +
          "in order after you finish. buy/sell require symbol and notional_usd; a sell beyond " +
          "what is held opens a short (not for prediction contracts — buy :NO — or parallel rates); hold " +
          "requires only rationale — on hold, set watch_symbol to the resolvable " +
          "instrument you most seriously considered, so the hold is scored as a " +
          "counterfactual. A lone hold means 'no action on this event'.",
        {
          action: z.enum(["buy", "sell", "hold"]),
          symbol: z.string().optional(),
          kind: z.enum(KINDS).optional(),
          notional_usd: z.number().positive().optional(),
          confidence: z.number().min(0).max(1),
          rationale: z.string(),
          evidence: z.array(z.string()).describe("Key facts/sources the decision rests on"),
          watch_symbol: z
            .string()
            .optional()
            .describe("On hold: the instrument you most seriously considered"),
          watch_kind: z.enum(KINDS).optional(),
          limit_price: z
            .number()
            .positive()
            .optional()
            .describe(
              "Max fill price for buys / min for sells. If the venue is closed or the " +
                "limit isn't met, the order parks and retries for up to 24h (at-open " +
                "semantics); set it to bound the gap you're willing to pay.",
            ),
        },
        async (args) => {
          if (args.action !== "hold" && (!args.symbol || !args.notional_usd)) {
            return text({ error: "buy/sell require symbol and notional_usd" });
          }
          holder.decisions.push({
            action: args.action,
            symbol: args.symbol,
            kind: args.kind === "auto" ? undefined : args.kind,
            notional_usd: args.notional_usd,
            confidence: args.confidence,
            rationale: args.rationale,
            evidence: args.evidence,
            watch_symbol: args.watch_symbol,
            watch_kind: args.watch_kind === "auto" ? undefined : args.watch_kind,
            limit_price: args.limit_price,
          });
          return text({
            ok: true,
            actions_so_far: holder.decisions.length,
            recorded: holder.decisions[holder.decisions.length - 1],
          });
        },
      ),
    ],
  });

  return { server, holder };
}
