// SPDX-License-Identifier: MIT-0
use fin_core::{env_keys, sources};
use fin_ingest::{FeedPoller, Publisher};
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};

const FEEDS: &[&str] = &[
    // Federal Reserve: all press releases (probed OK 2026-08-30).
    "https://www.federalreserve.gov/feeds/press_all.xml",
    // ECB press releases; serves RSS 2.0 despite the .html path (probed OK 2026-08-30).
    "https://www.ecb.europa.eu/rss/press.html",
];

/// Breaking macro/FX wire; forexlive.com 301s here since the rebrand (probed OK 2026-08-30).
/// Opt-in (`investinglive` in ENABLE_SOURCES, from the stack's `enableSources`): its terms
/// forbid copying content and say nothing about automated use (docs/THIRD_PARTY_NOTICES.md).
const INVESTINGLIVE_FEED: &str = "https://investinglive.com/feed/news";

fn investinglive_enabled(raw: &str) -> bool {
    raw.split(',').any(|s| s.trim().eq_ignore_ascii_case("investinglive"))
}

fn feeds(enable_sources: &str) -> Vec<&'static str> {
    let mut out = FEEDS.to_vec();
    if investinglive_enabled(enable_sources) {
        out.push(INVESTINGLIVE_FEED);
    }
    out
}

async fn handler(
    _event: LambdaEvent<serde_json::Value>,
    store: &Store,
    publisher: &Publisher,
    http: &reqwest::Client,
) -> Result<serde_json::Value, Error> {
    let poller = FeedPoller {
        http,
        store,
        publisher,
        source: sources::INGEST_MACRO,
        source_family: "macro",
        // Macro/central-bank news can move any asset class; the agents decide.
        asset_class_hint: None,
    };
    let mut total = 0usize;
    for feed in feeds(&std::env::var("ENABLE_SOURCES").unwrap_or_default()) {
        match poller.poll(feed).await {
            Ok(count) => {
                tracing::info!(feed, count, "polled");
                total += count;
            }
            Err(e) => tracing::error!(feed, error = %e, "poll failed"),
        }
    }
    Ok(serde_json::json!({ "published": total }))
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
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 fin-paper-trader/0.1")
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
    fn investinglive_is_opt_in() {
        assert!(!feeds("").contains(&INVESTINGLIVE_FEED));
        assert!(!feeds("yahoo,kalshi").contains(&INVESTINGLIVE_FEED));
        assert!(feeds("yahoo, InvestingLive").contains(&INVESTINGLIVE_FEED));
        assert_eq!(feeds("").len(), 2); // Fed and ECB always
    }
}
