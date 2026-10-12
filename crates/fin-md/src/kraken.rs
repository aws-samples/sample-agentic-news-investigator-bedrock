// SPDX-License-Identifier: MIT-0
use crate::{MdError, Quote, QuoteSource};
use chrono::Utc;
use fin_core::AssetClass;
use rust_decimal::Decimal;
use std::str::FromStr;

/// Kraken public ticker — keyless, includes bid/ask.
/// GET https://api.kraken.com/0/public/Ticker?pair=BTCUSD
pub struct KrakenSource {
    client: reqwest::Client,
}

impl KrakenSource {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

/// "BTC-USD" / "BTC" / "BTCUSD" → "BTCUSD" (Kraken accepts common aliases
/// and echoes back its internal pair name, e.g. XXBTZUSD).
fn to_pair(symbol: &str) -> String {
    let s = symbol.to_uppercase().replace('-', "");
    if s.ends_with("USD") {
        s
    } else {
        format!("{s}USD")
    }
}

fn parse_ticker(body: &serde_json::Value, symbol: &str) -> Result<Quote, MdError> {
    if let Some(errs) = body.get("error").and_then(|e| e.as_array()) {
        if !errs.is_empty() {
            return Err(MdError::NotFound(format!("{symbol}: {errs:?}")));
        }
    }
    let result = body
        .get("result")
        .and_then(|r| r.as_object())
        .filter(|o| !o.is_empty())
        .ok_or_else(|| MdError::NotFound(symbol.to_string()))?;
    // Result is keyed by Kraken's internal pair name; take the first entry.
    let (_, t) = result.iter().next().unwrap();

    let field = |key: &str| -> Result<Decimal, MdError> {
        t.get(key)
            .and_then(|v| v.get(0))
            .and_then(|v| v.as_str())
            .and_then(|s| Decimal::from_str(s).ok())
            .ok_or_else(|| MdError::Parse(format!("kraken {symbol}: missing {key}")))
    };
    let ask = field("a")?;
    let bid = field("b")?;
    let last = field("c")?;

    Ok(Quote {
        symbol: symbol.to_string(),
        asset_class: AssetClass::Crypto,
        price: last,
        bid: Some(bid),
        ask: Some(ask),
        as_of: Utc::now(),
        source: "kraken",
    })
}

#[async_trait::async_trait]
impl QuoteSource for KrakenSource {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError> {
        let url = format!(
            "https://api.kraken.com/0/public/Ticker?pair={}",
            to_pair(symbol)
        );
        let body: serde_json::Value = self.client.get(&url).send().await?.json().await?;
        parse_ticker(&body, symbol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_ticker() {
        // Shape captured live 2026-07-31.
        let body = serde_json::json!({
            "error": [],
            "result": { "XXBTZUSD": {
                "a": ["62946.10000", "1", "1.000"],
                "b": ["62946.00000", "1", "1.000"],
                "c": ["62946.10000", "0.00511806"]
            }}
        });
        let q = parse_ticker(&body, "BTC-USD").unwrap();
        assert_eq!(q.price.to_string(), "62946.10000");
        assert_eq!(q.bid.unwrap().to_string(), "62946.00000");
        assert_eq!(q.ask.unwrap().to_string(), "62946.10000");
    }

    #[test]
    fn kraken_error_maps_to_not_found() {
        let body = serde_json::json!({"error": ["EQuery:Unknown asset pair"]});
        assert!(matches!(
            parse_ticker(&body, "ZZZ"),
            Err(MdError::NotFound(_))
        ));
    }

    #[test]
    fn pair_normalization() {
        assert_eq!(to_pair("BTC-USD"), "BTCUSD");
        assert_eq!(to_pair("eth"), "ETHUSD");
        assert_eq!(to_pair("SOLUSD"), "SOLUSD");
    }
}
