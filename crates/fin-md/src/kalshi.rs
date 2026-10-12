// SPDX-License-Identifier: MIT-0
use crate::{MdError, Quote, QuoteSource};
use chrono::Utc;
use fin_core::AssetClass;
use rust_decimal::Decimal;
use std::str::FromStr;

/// Kalshi public market data (no auth needed for reads).
/// Symbol format: "MARKET-TICKER:YES" or "MARKET-TICKER:NO".
/// GET https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}
/// Prices come from the *_dollars decimal-string fields (probed 2026-08-01).
pub struct KalshiSource {
    client: reqwest::Client,
}

impl KalshiSource {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

pub(crate) fn split_side(symbol: &str) -> Result<(&str, bool), MdError> {
    let (ticker, side) = symbol
        .rsplit_once(':')
        .ok_or_else(|| MdError::Parse(format!("{symbol}: expected TICKER:YES|NO")))?;
    match side.to_uppercase().as_str() {
        "YES" => Ok((ticker, true)),
        "NO" => Ok((ticker, false)),
        _ => Err(MdError::Parse(format!("{symbol}: side must be YES or NO"))),
    }
}

fn dec_field(m: &serde_json::Value, key: &str) -> Option<Decimal> {
    m.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| Decimal::from_str(s).ok())
}

fn parse_market(body: &serde_json::Value, symbol: &str, yes: bool) -> Result<Quote, MdError> {
    let m = body
        .get("market")
        .ok_or_else(|| MdError::NotFound(symbol.to_string()))?;
    let (bid, ask) = if yes {
        (dec_field(m, "yes_bid_dollars"), dec_field(m, "yes_ask_dollars"))
    } else {
        (dec_field(m, "no_bid_dollars"), dec_field(m, "no_ask_dollars"))
    };
    // Binary contracts: mid of the traded side is the working price;
    // fall back to last trade if the book is empty.
    let price = match (bid, ask) {
        (Some(b), Some(a)) => (b + a) / Decimal::TWO,
        _ => dec_field(m, "last_price_dollars")
            .ok_or_else(|| MdError::Parse(format!("kalshi {symbol}: no prices")))?,
    };
    Ok(Quote {
        symbol: symbol.to_string(),
        asset_class: AssetClass::Prediction,
        price,
        bid,
        ask,
        as_of: Utc::now(),
        source: "kalshi",
    })
}

#[async_trait::async_trait]
impl QuoteSource for KalshiSource {
    async fn get_quote(&self, symbol: &str) -> Result<Quote, MdError> {
        let (ticker, yes) = split_side(symbol)?;
        let url = format!("https://api.elections.kalshi.com/trade-api/v2/markets/{ticker}");
        let resp = self.client.get(&url).send().await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(MdError::NotFound(symbol.to_string()));
        }
        let body: serde_json::Value = resp.json().await?;
        parse_market(&body, symbol, yes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_market() {
        // Field shapes captured live 2026-08-01.
        let body = serde_json::json!({ "market": {
            "ticker": "KXHURRICANE-26DEC01EPACMAJ-7",
            "yes_bid_dollars": "0.2300", "yes_ask_dollars": "0.3000",
            "no_bid_dollars": "0.7000", "no_ask_dollars": "0.7700",
            "last_price_dollars": "0.3400"
        }});
        let q = parse_market(&body, "KXHURRICANE-26DEC01EPACMAJ-7:YES", true).unwrap();
        assert_eq!(q.price.to_string(), "0.2650");
        assert_eq!(q.ask.unwrap().to_string(), "0.3000");

        let qn = parse_market(&body, "KXHURRICANE-26DEC01EPACMAJ-7:NO", false).unwrap();
        assert_eq!(qn.ask.unwrap().to_string(), "0.7700");
    }

    #[test]
    fn side_parsing() {
        assert!(matches!(split_side("ABC-1:YES"), Ok(("ABC-1", true))));
        assert!(matches!(split_side("ABC-1:no"), Ok(("ABC-1", false))));
        assert!(split_side("ABC-1").is_err());
        assert!(split_side("ABC-1:MAYBE").is_err());
    }
}
