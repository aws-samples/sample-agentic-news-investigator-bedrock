// SPDX-License-Identifier: MIT-0
use fin_core::{env_keys, sources, AssetClass};
use fin_ingest::{parse_feed, strip_html, NewsDraft, Publisher};
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use std::collections::HashMap;
use tokio::sync::OnceCell;

/// SEC requires an identifying User-Agent with contact info; set via env so
/// the deployer's real email is used. Policy also caps request rate at
/// 10 req/s — we make at most 2 requests per invocation.
const EDGAR_FEED: &str = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=40&output=atom";
const TICKER_MAP_URL: &str = "https://www.sec.gov/files/company_tickers.json";

static TICKER_MAP: OnceCell<HashMap<u64, String>> = OnceCell::const_new();

async fn ticker_map(http: &reqwest::Client) -> &'static HashMap<u64, String> {
    TICKER_MAP
        .get_or_init(|| async {
            match fetch_ticker_map(http).await {
                Ok(map) => {
                    tracing::info!(entries = map.len(), "loaded CIK->ticker map");
                    map
                }
                Err(e) => {
                    tracing::error!(error = %e, "ticker map fetch failed; hints disabled");
                    HashMap::new()
                }
            }
        })
        .await
}

async fn fetch_ticker_map(http: &reqwest::Client) -> Result<HashMap<u64, String>, Error> {
    let body: serde_json::Value = http.get(TICKER_MAP_URL).send().await?.json().await?;
    let mut map = HashMap::new();
    if let Some(obj) = body.as_object() {
        for entry in obj.values() {
            if let (Some(cik), Some(ticker)) = (
                entry.get("cik_str").and_then(|v| v.as_u64()),
                entry.get("ticker").and_then(|v| v.as_str()),
            ) {
                map.insert(cik, ticker.to_string());
            }
        }
    }
    Ok(map)
}

/// EDGAR atom titles look like: "8-K - ACME CORP (0001643721) (Filer)".
fn cik_from_title(title: &str) -> Option<u64> {
    let start = title.find('(')?;
    let end = title[start..].find(')')? + start;
    title[start + 1..end].trim().parse().ok()
}

async fn handler(
    _event: LambdaEvent<serde_json::Value>,
    store: &Store,
    publisher: &Publisher,
    http: &reqwest::Client,
) -> Result<serde_json::Value, Error> {
    let tickers = ticker_map(http).await;

    let resp = http.get(EDGAR_FEED).send().await?;
    let status = resp.status();
    if !status.is_success() {
        // 403 means the UA policy tripped — surface loudly.
        tracing::error!(%status, "EDGAR fetch failed");
        return Err(format!("EDGAR HTTP {status}").into());
    }
    let body = resp.bytes().await?;
    let entries = parse_feed(&body).map_err(|e| Error::from(e.to_string()))?;

    let mut published = 0usize;
    for entry in entries {
        if !store
            .claim_dedupe("edgar", &entry.source_id)
            .await
            .map_err(|e| Error::from(e.to_string()))?
        {
            continue;
        }
        let hint = cik_from_title(&entry.headline)
            .and_then(|cik| tickers.get(&cik))
            .map(|t| vec![t.clone()])
            .unwrap_or_default();
        let full_text = strip_html(&entry.summary);
        publisher
            .publish_news(NewsDraft {
                source: sources::INGEST_EDGAR,
                source_family: "edgar",
                entry: &entry,
                full_text: &full_text,
                tickers_hint: hint,
                asset_class_hint: Some(AssetClass::Equity),
            })
            .await
            .map_err(|e| Error::from(e.to_string()))?;
        published += 1;
    }
    tracing::info!(published, "edgar poll complete");
    Ok(serde_json::json!({ "published": published }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    fin_core::logging::init_tracing();

    let config = aws_config::load_from_env().await;
    let store = Store::new(
        aws_sdk_dynamodb::Client::new(&config),
        std::env::var(env_keys::TABLE_NAME)?,
    );
    let publisher = Publisher {
        events: aws_sdk_eventbridge::Client::new(&config),
        s3: aws_sdk_s3::Client::new(&config),
        bus_name: std::env::var(env_keys::BUS_NAME)?,
        body_bucket: std::env::var(env_keys::BODY_BUCKET)?,
    };
    // SEC fair-access policy: identify yourself. EDGAR_CONTACT must be a real,
    // reachable email address; the CDK stack passes it from its `contactEmail`
    // context. There is deliberately no fallback: an anonymous poller is what
    // the policy refuses, so a missing contact fails the function at startup.
    let contact = std::env::var("EDGAR_CONTACT")
        .ok()
        .filter(|c| !c.trim().is_empty())
        .ok_or("EDGAR_CONTACT must be set to a reachable contact email (SEC fair-access policy)")?;
    let http = reqwest::Client::builder()
        .user_agent(format!("fin-paper-trader/0.1 {contact}"))
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    lambda_runtime::run(service_fn(|event| {
        handler(event, &store, &publisher, &http)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_cik() {
        assert_eq!(
            cik_from_title("8-K - DATZ WORLD HOLDINGS CORP. (0001643721) (Filer)"),
            Some(1643721)
        );
        assert_eq!(cik_from_title("no parens here"), None);
    }
}
