// SPDX-License-Identifier: MIT-0
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetClass {
    Equity,
    Crypto,
    /// Prediction-market binary contract. Symbol format:
    /// `KX<TICKER>:YES|NO` (Kalshi) or `<polymarket-slug>:YES|NO`.
    Prediction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Buy,
    Sell,
    Hold,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Sentiment {
    Positive,
    Negative,
    Neutral,
    Mixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRef {
    pub symbol: String,
    pub asset_class: AssetClass,
}

/// detail-type: NewsItem
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewsItem {
    pub id: String,
    pub source_family: String,
    /// Stable upstream identifier (EDGAR accession number, RSS guid).
    pub source_id: String,
    pub published_at: DateTime<Utc>,
    pub ingested_at: DateTime<Utc>,
    pub headline: String,
    /// Truncated to ~4KB; full text lives at `body_s3_uri`.
    pub summary: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_s3_uri: Option<String>,
    #[serde(default)]
    pub tickers_hint: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_class_hint: Option<AssetClass>,
}

/// detail-type: SignalCandidate
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalCandidate {
    pub id: String,
    pub news_id: String,
    pub assets: Vec<AssetRef>,
    pub event_type: String,
    pub sentiment: Sentiment,
    pub materiality: f64,
    pub rationale: String,
    pub model_id: String,
    pub created_at: DateTime<Utc>,
    /// Carried through so the analysis agent has context without a lookup.
    pub headline: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_s3_uri: Option<String>,
}

/// detail-type: TradeDecision
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeDecision {
    pub id: String,
    pub signal_id: String,
    pub news_id: String,
    pub action: Action,
    pub symbol: String,
    pub asset_class: AssetClass,
    #[serde(with = "rust_decimal::serde::str")]
    pub notional_usd: Decimal,
    pub confidence: f64,
    pub time_horizon: String,
    pub rationale: String,
    pub model_id: String,
    pub created_at: DateTime<Utc>,
}

/// detail-type: TradeApproved | TradeRejected
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskVerdict {
    pub decision_id: String,
    pub verdict: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub checked_at: DateTime<Utc>,
    /// Full decision carried through so exec doesn't need a lookup.
    pub decision: TradeDecision,
}

/// detail-type: OrderFilled
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderFilled {
    pub order_id: String,
    pub decision_id: String,
    pub symbol: String,
    pub asset_class: AssetClass,
    pub side: Side,
    #[serde(with = "rust_decimal::serde::str")]
    pub qty: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub quote_price: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub fill_price: Decimal,
    pub slippage_bps: i64,
    #[serde(with = "rust_decimal::serde::str")]
    pub notional_usd: Decimal,
    pub quote_source: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub cash_after: Decimal,
    pub filled_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn news_item_round_trips() {
        let item = NewsItem {
            id: "nws_01ABC".into(),
            source_family: "edgar".into(),
            source_id: "0001234567-26-000001".into(),
            published_at: Utc::now(),
            ingested_at: Utc::now(),
            headline: "ACME Corp announces merger".into(),
            summary: "ACME Corp today announced...".into(),
            url: "https://www.sec.gov/...".into(),
            body_s3_uri: None,
            tickers_hint: vec!["ACME".into()],
            asset_class_hint: Some(AssetClass::Equity),
        };
        let json = serde_json::to_string(&item).unwrap();
        let back: NewsItem = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, item.id);
        assert!(!json.contains("body_s3_uri"));
    }

    #[test]
    fn decimal_serializes_as_string() {
        let d = TradeDecision {
            id: "dcn_1".into(),
            signal_id: "sig_1".into(),
            news_id: "nws_1".into(),
            action: Action::Buy,
            symbol: "ACME".into(),
            asset_class: AssetClass::Equity,
            notional_usd: Decimal::new(250000, 2),
            confidence: 0.74,
            time_horizon: "days".into(),
            rationale: "test".into(),
            model_id: "m".into(),
            created_at: Utc::now(),
        };
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"notional_usd\":\"2500.00\""));
        assert!(json.contains("\"action\":\"buy\""));
    }
}
