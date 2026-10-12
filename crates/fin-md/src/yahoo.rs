// SPDX-License-Identifier: MIT-0
use crate::{MdError, Quote, QuoteSource};
use chrono::{DateTime, Utc};
use fin_core::AssetClass;
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;

/// Unofficial Yahoo Finance chart API. Keyless but requires a browser-ish
/// User-Agent. query1 primary, query2 fallback.
pub struct YahooSource {
    client: reqwest::Client,
}

impl YahooSource {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }

    async fn fetch(&self, host: &str, symbol: &str) -> Result<Quote, MdError> {
        let url = format!(
            "https://{host}/v8/finance/chart/{symbol}?interval=1m&range=1d"
        );
        let body: serde_json::Value = self.client.get(&url).send().await?.json().await?;
        parse_chart_meta(&body, symbol)
    }
}

fn parse_chart_meta(body: &serde_json::Value, symbol: &str) -> Result<Quote, MdError> {
    let meta = body
        .pointer("/chart/result/0/meta")
        .ok_or_else(|| MdError::NotFound(symbol.to_string()))?;
    let price = meta
        .get("regularMarketPrice")
        .and_then(|v| v.as_f64())
        .and_then(Decimal::from_f64)
        .ok_or_else(|| MdError::Parse(format!("no regularMarketPrice for {symbol}")))?;
    let ts = meta
        .get("regularMarketTime")
        .and_then(|v| v.as_i64())
        .and_then(|s| DateTime::<Utc>::from_timestamp(s, 0))
        .ok_or_else(|| MdError::Parse(format!("no regularMarketTime for {symbol}")))?;
    Ok(Quote {
        symbol: symbol.to_string(),
        asset_class: AssetClass::Equity,
        price,
        bid: None,
        ask: None,
        as_of: ts,
        source: "yahoo",
    })
}

#[async_trait::async_trait]
impl QuoteSource for YahooSource {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError> {
        match self.fetch("query1.finance.yahoo.com", symbol).await {
            Ok(q) => Ok(q),
            Err(_) => self.fetch("query2.finance.yahoo.com", symbol).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_chart_response() {
        // Shape captured live 2026-07-31.
        let body: serde_json::Value = serde_json::json!({
            "chart": { "result": [ { "meta": {
                "currency": "USD", "symbol": "AAPL",
                "regularMarketPrice": 308.91,
                "regularMarketTime": 1785528001_i64
            }}]}
        });
        let q = parse_chart_meta(&body, "AAPL").unwrap();
        assert_eq!(q.price.to_string(), "308.91");
        assert_eq!(q.source, "yahoo");
    }

    #[test]
    fn missing_symbol_is_not_found() {
        let body = serde_json::json!({"chart": {"result": null, "error": {"code": "Not Found"}}});
        assert!(matches!(
            parse_chart_meta(&body, "ZZZZ"),
            Err(MdError::NotFound(_))
        ));
    }
}
