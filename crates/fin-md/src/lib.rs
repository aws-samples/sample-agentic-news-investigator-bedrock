// SPDX-License-Identifier: MIT-0
mod coinbase;
mod kalshi;
mod kraken;
pub mod market_search;
mod polymarket;
mod yahoo;

pub use coinbase::CoinbaseSource;
pub use kalshi::KalshiSource;
pub use kraken::KrakenSource;
pub use market_search::{search_markets, search_markets_with, MarketHit};
pub use polymarket::PolymarketSource;
pub use yahoo::YahooSource;

use chrono::{DateTime, Utc};
use fin_core::AssetClass;
use rust_decimal::Decimal;

#[derive(Debug, thiserror::Error)]
pub enum MdError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("parse error: {0}")]
    Parse(String),
    #[error("symbol not found: {0}")]
    NotFound(String),
    #[error("price source {0} is not enabled in this deployment (ENABLE_SOURCES)")]
    Disabled(&'static str),
}

/// Opt-in price sources: providers whose terms do not permit this sample's use
/// without the deployer's own permission (docs/THIRD_PARTY_NOTICES.md, reviewed
/// 2026-10-07). Yahoo's terms prohibit automated collection without permission;
/// Kalshi's limit API use to a member's own trading and prohibit AI/ML use;
/// Coinbase's and Polymarket's could not be retrieved for review. All are off unless named in `ENABLE_SOURCES` (comma-separated), which the
/// stack sets from the `enableSources` context value. A disabled source makes
/// no network call.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnabledSources {
    pub yahoo: bool,
    pub kalshi: bool,
    pub coinbase: bool,
    pub polymarket: bool,
}

impl EnabledSources {
    pub fn parse(raw: &str) -> Self {
        let mut out = Self::default();
        for name in raw.split(',').map(|s| s.trim().to_ascii_lowercase()) {
            match name.as_str() {
                "yahoo" => out.yahoo = true,
                "kalshi" => out.kalshi = true,
                "coinbase" => out.coinbase = true,
                "polymarket" => out.polymarket = true,
                // Feed switches read by the pollers, not price sources.
                "" | "investinglive" => {}
                other => tracing::warn!(source = other, "ENABLE_SOURCES: unknown source ignored"),
            }
        }
        out
    }

    pub fn from_env() -> Self {
        Self::parse(&std::env::var("ENABLE_SOURCES").unwrap_or_default())
    }
}

#[derive(Debug, Clone)]
pub struct Quote {
    pub symbol: String,
    pub asset_class: AssetClass,
    pub price: Decimal,
    /// Bid/ask when the source provides them (Kraken does; Yahoo doesn't).
    pub bid: Option<Decimal>,
    pub ask: Option<Decimal>,
    pub as_of: DateTime<Utc>,
    pub source: &'static str,
}

#[async_trait::async_trait]
pub trait QuoteSource: Send + Sync {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError>;
}

/// Routes to the right source per asset class, with per-class fallback.
/// Live-probed 2026-07-31: Stooq is behind a JS proof-of-work wall (unusable
/// headless); Yahoo chart API and Kraken public ticker both work keyless.
pub struct Router {
    equity_primary: YahooSource,
    crypto_primary: KrakenSource,
    crypto_fallback: CoinbaseSource,
    prediction_polymarket: PolymarketSource,
    prediction_kalshi: KalshiSource,
    sources: EnabledSources,
}

impl Router {
    /// Opt-in sources come from `ENABLE_SOURCES` (see [`EnabledSources`]).
    pub fn new(client: reqwest::Client) -> Self {
        Self::with_sources(client, EnabledSources::from_env())
    }

    pub fn with_sources(client: reqwest::Client, sources: EnabledSources) -> Self {
        Self {
            equity_primary: YahooSource::new(client.clone()),
            crypto_primary: KrakenSource::new(client.clone()),
            crypto_fallback: CoinbaseSource::new(client.clone()),
            prediction_polymarket: PolymarketSource::new(client.clone()),
            prediction_kalshi: KalshiSource::new(client),
            sources,
        }
    }

    pub async fn get_quote(
        &self,
        symbol: &str,
        asset_class: AssetClass,
    ) -> Result<Quote, MdError> {
        match asset_class {
            AssetClass::Equity if !self.sources.yahoo => Err(MdError::Disabled("yahoo")),
            AssetClass::Equity => self.equity_primary.get_quote(symbol).await,
            AssetClass::Crypto => match self.crypto_primary.get_quote(symbol).await {
                Ok(q) => Ok(q),
                Err(e) if !self.sources.coinbase => Err(e),
                Err(e) => {
                    tracing::warn!(error = %e, symbol, "kraken failed, falling back to coinbase");
                    self.crypto_fallback.get_quote(symbol).await
                }
            },
            // Kalshi tickers are SCREAMING-KEBAB (KXHURRICANE-...); Polymarket
            // slugs are lowercase. Route on case, fall back to the other venue.
            AssetClass::Prediction => {
                match (self.sources.kalshi, self.sources.polymarket) {
                    (false, false) => return Err(MdError::Disabled("kalshi, polymarket")),
                    (false, true) => return self.prediction_polymarket.get_quote(symbol).await,
                    (true, false) => return self.prediction_kalshi.get_quote(symbol).await,
                    (true, true) => {}
                }
                let looks_kalshi = symbol
                    .chars()
                    .take_while(|c| *c != ':')
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-' || c == '_');
                let (first, second): (&dyn QuoteSource, &dyn QuoteSource) = if looks_kalshi {
                    (&self.prediction_kalshi, &self.prediction_polymarket)
                } else {
                    (&self.prediction_polymarket, &self.prediction_kalshi)
                };
                match first.get_quote(symbol).await {
                    Ok(q) => Ok(q),
                    Err(e) => {
                        tracing::warn!(error = %e, symbol, "primary prediction venue failed");
                        second.get_quote(symbol).await
                    }
                }
            }
        }
    }
}

pub fn default_client() -> reqwest::Client {
    reqwest::Client::builder()
        // Yahoo rejects non-browser UAs; this one works for Kraken/Coinbase too.
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) fin-paper-trader/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("client build")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_are_off_by_default() {
        assert_eq!(EnabledSources::parse(""), EnabledSources::default());
        assert!(!EnabledSources::default().yahoo && !EnabledSources::default().kalshi);
    }

    #[test]
    fn sources_parse_names_any_case() {
        let s = EnabledSources::parse(" Yahoo ,kalshi,bogus,Coinbase,polymarket");
        assert!(s.yahoo && s.kalshi && s.coinbase && s.polymarket);
        assert!(!EnabledSources::parse("kalshi").yahoo);
    }

    #[tokio::test]
    async fn disabled_yahoo_refuses_equities_without_a_request() {
        // An unroutable proxy: any request would fail with Http, not Disabled.
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
            .build()
            .unwrap();
        let r = Router::with_sources(client, EnabledSources::default());
        let err = r.get_quote("SPY", AssetClass::Equity).await.unwrap_err();
        assert!(matches!(err, MdError::Disabled("yahoo")), "{err}");
        let err = r.get_quote("some-market:YES", AssetClass::Prediction).await.unwrap_err();
        assert!(matches!(err, MdError::Disabled(_)), "{err}");
    }

    #[tokio::test]
    async fn disabled_polymarket_search_returns_nothing_without_a_request() {
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
            .build()
            .unwrap();
        let hits = market_search::search_markets_with(&client, "hurricane", 5, EnabledSources::default())
            .await
            .unwrap();
        assert!(hits.is_empty());
    }
}
