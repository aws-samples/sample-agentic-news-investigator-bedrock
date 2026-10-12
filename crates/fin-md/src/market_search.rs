// SPDX-License-Identifier: MIT-0
use crate::{EnabledSources, MdError};
use serde::Serialize;

/// A prediction market found by free-text search, normalized across venues.
#[derive(Debug, Clone, Serialize)]
pub struct MarketHit {
    /// Tradable symbol for get_quote: "<ticker-or-slug>:YES".
    pub symbol: String,
    pub venue: &'static str,
    pub question: String,
    /// YES price in [0,1], best info available from the search endpoint.
    pub yes_price: Option<String>,
    pub volume: Option<String>,
    pub close_time: Option<String>,
}

/// Search Polymarket's Gamma public-search. Kalshi has no public free-text
/// search endpoint (probed 2026-08-01: /search is 404), so Polymarket is the
/// discovery venue; Kalshi symbols can still be quoted directly when known.
///
/// Polymarket is an opt-in source (`EnabledSources`, from `ENABLE_SOURCES`):
/// when it is off this returns no hits and makes no request.
pub async fn search_markets(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<MarketHit>, MdError> {
    search_markets_with(client, query, limit, EnabledSources::from_env()).await
}

pub async fn search_markets_with(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    sources: EnabledSources,
) -> Result<Vec<MarketHit>, MdError> {
    if !sources.polymarket {
        return Ok(Vec::new());
    }
    let url = format!(
        "https://gamma-api.polymarket.com/public-search?q={}&limit_per_type={}",
        urlencode(query),
        limit.clamp(1, 10)
    );
    let body: serde_json::Value = client.get(&url).send().await?.json().await?;
    let mut hits = Vec::new();
    for ev in body.get("events").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
        for m in ev.get("markets").and_then(|v| v.as_array()).unwrap_or(&vec![]) {
            if m.get("closed").and_then(|v| v.as_bool()).unwrap_or(false) {
                continue;
            }
            let Some(slug) = m.get("slug").and_then(|v| v.as_str()) else {
                continue;
            };
            let yes_price = m
                .get("outcomePrices")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .and_then(|v| v.first().cloned());
            hits.push(MarketHit {
                symbol: format!("{slug}:YES"),
                venue: "polymarket",
                question: m
                    .get("question")
                    .and_then(|v| v.as_str())
                    .unwrap_or(slug)
                    .to_string(),
                yes_price,
                volume: m.get("volume").and_then(|v| v.as_str()).map(String::from),
                close_time: m.get("endDate").and_then(|v| v.as_str()).map(String::from),
            });
            if hits.len() >= limit {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c.to_string(),
            ' ' => "%20".to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencodes_queries() {
        assert_eq!(urlencode("hurricane landfall"), "hurricane%20landfall");
        assert_eq!(urlencode("cat-4"), "cat-4");
    }
}
