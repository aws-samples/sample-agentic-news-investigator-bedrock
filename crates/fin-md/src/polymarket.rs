// SPDX-License-Identifier: MIT-0
use crate::kalshi::split_side;
use crate::{MdError, Quote, QuoteSource};
use chrono::Utc;
use fin_core::AssetClass;
use rust_decimal::Decimal;
use rust_decimal::prelude::FromPrimitive;
use std::str::FromStr;

/// Polymarket Gamma API (public, keyless).
/// Symbol format: "market-slug:YES" or "market-slug:NO".
/// GET https://gamma-api.polymarket.com/markets?slug={slug}
/// bestBid/bestAsk are JSON numbers for the YES side; outcomePrices is a
/// JSON-encoded string array ["yes","no"] (probed 2026-08-01).
pub struct PolymarketSource {
    client: reqwest::Client,
}

impl PolymarketSource {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

fn parse_market(body: &serde_json::Value, symbol: &str, yes: bool) -> Result<Quote, MdError> {
    let m = body
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| MdError::NotFound(symbol.to_string()))?;

    let yes_bid = m.get("bestBid").and_then(|v| v.as_f64()).and_then(Decimal::from_f64);
    let yes_ask = m.get("bestAsk").and_then(|v| v.as_f64()).and_then(Decimal::from_f64);
    // NO side is the complement of the YES book.
    let one = Decimal::ONE;
    let (bid, ask) = if yes {
        (yes_bid, yes_ask)
    } else {
        (yes_ask.map(|a| one - a), yes_bid.map(|b| one - b))
    };

    let idx = if yes { 0 } else { 1 };
    let outcome_price = m
        .get("outcomePrices")
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .and_then(|v| v.get(idx).cloned())
        .and_then(|s| Decimal::from_str(&s).ok());

    let price = match (bid, ask) {
        (Some(b), Some(a)) => (b + a) / Decimal::TWO,
        _ => outcome_price
            .ok_or_else(|| MdError::Parse(format!("polymarket {symbol}: no prices")))?,
    };
    Ok(Quote {
        symbol: symbol.to_string(),
        asset_class: AssetClass::Prediction,
        price,
        bid,
        ask,
        as_of: Utc::now(),
        source: "polymarket",
    })
}

#[async_trait::async_trait]
impl QuoteSource for PolymarketSource {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError> {
        let (slug, yes) = split_side(symbol)?;
        let url = format!("https://gamma-api.polymarket.com/markets?slug={slug}");
        let body: serde_json::Value = self.client.get(&url).send().await?.json().await?;
        parse_market(&body, symbol, yes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_market() {
        // Shape captured live 2026-08-01.
        let body = serde_json::json!([{
            "question": "Will any Category 4 hurricane make landfall in the US in before 2027?",
            "outcomePrices": "[\"0.245\", \"0.755\"]",
            "bestBid": 0.24,
            "bestAsk": 0.25,
            "closed": false
        }]);
        let q = parse_market(&body, "cat4-landfall:YES", true).unwrap();
        assert_eq!(q.price.to_string(), "0.2450");

        let qn = parse_market(&body, "cat4-landfall:NO", false).unwrap();
        assert_eq!(qn.bid.unwrap().to_string(), "0.75");
        assert_eq!(qn.ask.unwrap().to_string(), "0.76");
    }

    #[test]
    fn empty_result_is_not_found() {
        let body = serde_json::json!([]);
        assert!(matches!(
            parse_market(&body, "nope:YES", true),
            Err(MdError::NotFound(_))
        ));
    }
}
