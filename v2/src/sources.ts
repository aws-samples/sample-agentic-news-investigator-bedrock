// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";

/**
 * Data sources whose terms do not permit this sample's use without the
 * deployer's own permission (docs/THIRD_PARTY_NOTICES.md, reviewed 2026-10-07):
 *
 * - yahoo: Yahoo's Terms of Service prohibit collecting data "using any
 *   automated means" without express prior permission. Yahoo prices equities,
 *   ETFs, ADRs, international listings and futures, the FX reference rate
 *   behind Kraken, the long tail of crypto, the benchmark comparison and the
 *   bench's historical bars.
 * - kalshi: Kalshi's Developer Agreement limits API use to a member's own
 *   trading and its Data Terms prohibit use with AI/ML systems.
 * - coinbase: Coinbase's Market Data and Developer Platform terms could not be
 *   retrieved for review; the crypto spot fallback behind Kraken.
 * - polymarket: Polymarket's Terms of Use could not be read from the US; its
 *   quotes, market search and settlement checks.
 *
 * All are OFF unless named in V2_ENABLE_SOURCES (comma-separated, e.g.
 * `yahoo,kalshi`). A disabled source makes no network call: its fetchers return
 * nothing and the resolver says why. Enable one only if you hold the provider's
 * permission, or point the code at a licensed feed (docs/OPERATIONS.md,
 * "Opt-in data sources").
 *
 * The parsing and the prompt text are pure; only `sourceEnabled` reads config.
 */
export const OPT_IN_SOURCES = ["yahoo", "kalshi", "coinbase", "polymarket"] as const;
export type OptInSource = (typeof OPT_IN_SOURCES)[number];

export function parseEnabledSources(raw: string | undefined): Set<OptInSource> {
  const out = new Set<OptInSource>();
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim().toLowerCase();
    if ((OPT_IN_SOURCES as readonly string[]).includes(name)) out.add(name as OptInSource);
    else if (name) console.warn(`[sources] V2_ENABLE_SOURCES: unknown source "${name}" ignored`);
  }
  return out;
}

const enabled = parseEnabledSources(config.enableSources);

export function sourceEnabled(name: OptInSource): boolean {
  return enabled.has(name);
}

/** The resolver's answer for an instrument whose only price source is disabled. */
export function disabledReason(symbol: string, name: OptInSource): string {
  return `${symbol}: its price source (${name}) is not enabled in this deployment (V2_ENABLE_SOURCES); not tradeable here`;
}

/**
 * The investigator prompt's note on what a disabled source removes from the
 * universe; empty when every opt-in source is enabled, so an enabled
 * deployment sees the prompt unchanged.
 */
export function sourcesPromptSection(isEnabled: (name: OptInSource) => boolean = sourceEnabled): string {
  const lines: string[] = [];
  if (!isEnabled("yahoo")) {
    lines.push(
      "- Yahoo is not enabled: equities, ETFs, ADRs, international listings and futures do NOT resolve and cannot be traded. FX resolves only where Kraken quotes the pair; crypto only where Kraken (or Coinbase, if enabled) does.",
    );
  }
  if (!isEnabled("coinbase")) {
    lines.push("- Coinbase is not enabled: crypto resolves only where Kraken quotes it.");
  }
  const kalshi = isEnabled("kalshi");
  const polymarket = isEnabled("polymarket");
  if (!kalshi && !polymarket) {
    lines.push("- No prediction-market source is enabled: contracts do not resolve and search_markets returns nothing.");
  } else if (!polymarket) {
    lines.push("- Polymarket is not enabled: search_markets returns nothing; Kalshi contracts resolve only by ticker.");
  } else if (!kalshi) {
    lines.push("- Kalshi is not enabled: prediction-market contracts resolve on Polymarket only.");
  }
  return lines.length === 0
    ? ""
    : `\n\n## Price sources in this deployment\nThe universe below is narrowed by the sources this deployment has enabled. Anything listed here as unavailable will not resolve; do not spend turns trying it.\n${lines.join("\n")}`;
}
