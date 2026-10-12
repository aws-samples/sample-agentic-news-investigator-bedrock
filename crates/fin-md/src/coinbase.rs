// SPDX-License-Identifier: MIT-0
use crate::{MdError, Quote, QuoteSource};
use chrono::Utc;
use fin_core::AssetClass;
use rust_decimal::Decimal;
use std::str::FromStr;

/// Coinbase v2 spot price — keyless fallback for crypto.
/// GET https://api.coinbase.com/v2/prices/BTC-USD/spot
/// Spot only (no bid/ask); the exec engine falls back to a bps slippage
/// floor when no spread is available.
pub struct CoinbaseSource {
    client: reqwest::Client,
}

impl CoinbaseSource {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

fn to_pair(symbol: &str) -> String {
    let s = symbol.to_uppercase();
    if s.contains('-') {
        s
    } else if let Some(base) = s.strip_suffix("USD") {
        format!("{base}-USD")
    } else {
        format!("{s}-USD")
    }
}

fn parse_spot(body: &serde_json::Value, symbol: &str) -> Result<Quote, MdError> {
    let amount = body
        .pointer("/data/amount")
        .and_then(|v| v.as_str())
        .and_then(|s| Decimal::from_str(s).ok())
        .ok_or_else(|| MdError::NotFound(symbol.to_string()))?;
    Ok(Quote {
        symbol: symbol.to_string(),
        asset_class: AssetClass::Crypto,
        price: amount,
        bid: None,
        ask: None,
        as_of: Utc::now(),
        source: "coinbase",
    })
}

#[async_trait::async_trait]
impl QuoteSource for CoinbaseSource {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError> {
        let url = format!(
            "https://api.coinbase.com/v2/prices/{}/spot",
            to_pair(symbol)
        );
        let body: serde_json::Value = self.client.get(&url).send().await?.json().await?;
        parse_spot(&body, symbol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spot_response() {
        let body = serde_json::json!({"data": {"amount": "62950.55", "base": "BTC", "currency": "USD"}});
        let q = parse_spot(&body, "BTC-USD").unwrap();
        assert_eq!(q.price.to_string(), "62950.55");
        assert!(q.bid.is_none());
    }

    #[test]
    fn pair_normalization() {
        assert_eq!(to_pair("BTCUSD"), "BTC-USD");
        assert_eq!(to_pair("eth-usd"), "ETH-USD");
        assert_eq!(to_pair("SOL"), "SOL-USD");
    }
}
