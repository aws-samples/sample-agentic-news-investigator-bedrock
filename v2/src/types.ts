// SPDX-License-Identifier: MIT-0
export type InstrumentKind =
  | "fx"
  | "parallel_fx"
  | "equity"
  | "crypto"
  | "prediction";

export interface Quote {
  symbol: string;
  kind: InstrumentKind;
  /** For fx, units of quote currency per base; for everything else, USD. */
  price: number;
  bid?: number;
  ask?: number;
  /** Epoch millis of the quote's timestamp. */
  asOfMs: number;
  source: string;
  /** Resting book depth in USD when the venue reports it (prediction markets). */
  liquidityUsd?: number;
  /** Set when a prediction market has resolved: price is the payout (1 or 0). */
  resolved?: boolean;
}

export interface ResolvedInstrument {
  ok: true;
  quote: Quote;
  meta: {
    /** Both bid and ask present and positive. */
    hasBook: boolean;
    ageSecs: number;
    /**
     * Quote is an indicative reference rate (no order book). Pegged or
     * capital-controlled currencies quote here but barely move; a paper fill
     * against one is close to fiction. Surfaced to the agent, not hard-blocked.
     */
    indicativeOnly: boolean;
    /** Why this quote was chosen when it is not the obvious venue (e.g. FX reference over a thin book). */
    note?: string;
    /**
     * Set by the as-of resolver when the quote is a historical bar: the bar's
     * length in seconds. A bar's close is only known at the bar's end, so the
     * price is at most this stale by construction; the bench widens its
     * staleness bound to it (granularity, not a closed venue).
     */
    barSpanSecs?: number;
  };
}

export interface Unresolved {
  ok: false;
  reason: string;
}

export type Resolution = ResolvedInstrument | Unresolved;

export interface NewsItem {
  id: string;
  source_family: string;
  source_id: string;
  published_at: string;
  ingested_at: string;
  headline: string;
  summary: string;
  url: string;
  body_s3_uri?: string | null;
  tickers_hint: string[];
  asset_class_hint?: string | null;
  /** v2/v3 only: pre-triage filing summary (enrich.ts). Absent on the wire. */
  enrichment?: {
    summary: string;
    items: string[];
    tickers: string[];
    source_ref: string;
    model: string;
    /** The summarizer's reported token usage and its cost at `model`'s rates (pricing.ts). */
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    };
    cost_usd?: number;
  };
}

export interface TradeDecision {
  action: "buy" | "sell" | "hold";
  symbol?: string;
  kind?: InstrumentKind;
  notional_usd?: number;
  confidence: number;
  rationale: string;
  evidence: string[];
  /** On hold: the instrument most seriously considered, scored as a counterfactual. */
  watch_symbol?: string;
  watch_kind?: InstrumentKind;
  /**
   * Optional limit: max fill price for buys / min for sells. When the venue is
   * closed or the limit isn't met, the order parks and is retried until expiry.
   */
  limit_price?: number;
  /**
   * Internal, never set by the agent: the order may only shrink an existing
   * position (a sell caps at the long held, a buy at the short outstanding) and
   * is refused once it is gone. The pending retry sets it on the working
   * remainder of a liquidity-capped exit.
   */
  reduce_only?: boolean;
}
