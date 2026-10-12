// SPDX-License-Identifier: MIT-0

/**
 * Opt-in data sources: providers whose terms do not permit this sample's use
 * without the deployer's own permission (docs/THIRD_PARTY_NOTICES.md, reviewed
 * 2026-10-07). Off unless named in the `enableSources` context value, e.g.
 * `cdk deploy -c enableSources=yahoo,kalshi,crypto-news`.
 *
 *   yahoo          Yahoo Finance chart endpoints: the v1 equity price source.
 *   kalshi         Kalshi market data: v1 prediction quotes.
 *   coinbase       Coinbase spot prices: the v1 crypto fallback behind Kraken.
 *   polymarket     Polymarket Gamma API: v1 prediction quotes and market search.
 *   crypto-news    CoinDesk and Cointelegraph RSS: poller-crypto-news and its
 *                  schedule are deployed only when this is named.
 *   globenewswire  GlobeNewswire RSS: poller-prwire and its schedule, likewise.
 *   investinglive  investingLive RSS: one of poller-macro's feeds (the Fed and
 *                  ECB feeds always run).
 *
 * Kalshi's, Yahoo's, CoinDesk's and Cointelegraph's terms prohibit this use
 * without permission; Coinbase's, Polymarket's and GlobeNewswire's could not be
 * retrieved and investingLive's do not address automated use, so those are
 * opt-in as a precaution. Everything except the two poller switches reaches the
 * Lambdas as ENABLE_SOURCES (read by fin-md's `EnabledSources::from_env` and by
 * poller-macro). The v2/v3 workers are configured separately,
 * with V2_ENABLE_SOURCES (v2/src/sources.ts).
 */
export const OPT_IN_SOURCES = [
  'yahoo',
  'kalshi',
  'coinbase',
  'polymarket',
  'crypto-news',
  'globenewswire',
  'investinglive',
] as const;
export type OptInSource = (typeof OPT_IN_SOURCES)[number];

export function parseEnabledSources(raw: string | undefined): Set<OptInSource> {
  const out = new Set<OptInSource>();
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!(OPT_IN_SOURCES as readonly string[]).includes(name)) {
      throw new Error(
        `The "enableSources" context value names an unknown source "${name}"; ` +
          `known: ${OPT_IN_SOURCES.join(', ')}.`,
      );
    }
    out.add(name as OptInSource);
  }
  return out;
}

/** The Lambdas' ENABLE_SOURCES value, in a stable order (the poller switches are not runtime flags). */
export function lambdaSourcesEnv(enabled: Set<OptInSource>): string {
  return (['yahoo', 'kalshi', 'coinbase', 'polymarket', 'investinglive'] as const)
    .filter((s) => enabled.has(s))
    .join(',');
}
