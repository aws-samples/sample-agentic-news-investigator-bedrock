// SPDX-License-Identifier: MIT-0
use fin_core::{env_keys, sources, AssetClass};
use fin_ingest::{FeedPoller, Publisher};
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};

const FEEDS: &[&str] = &[
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
];

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
        source: sources::INGEST_CRYPTO,
        source_family: "crypto",
        asset_class_hint: Some(AssetClass::Crypto),
    };
    let mut total = 0usize;
    for feed in FEEDS {
        match poller.poll(feed).await {
            Ok(count) => {
                tracing::info!(feed, count, "polled");
                total += count;
            }
            // One bad feed must not block the others.
            Err(e) => tracing::error!(feed, error = %e, "poll failed"),
        }
    }
    Ok(serde_json::json!({ "published": total }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    fin_core::logging::init_tracing();

    let config = aws_config::load_from_env().await;
    let table = std::env::var(env_keys::TABLE_NAME)?;
    let bus = std::env::var(env_keys::BUS_NAME)?;
    let bucket = std::env::var(env_keys::BODY_BUCKET)?;

    let store = Store::new(aws_sdk_dynamodb::Client::new(&config), table);
    let publisher = Publisher {
        events: aws_sdk_eventbridge::Client::new(&config),
        s3: aws_sdk_s3::Client::new(&config),
        bus_name: bus,
        body_bucket: bucket,
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
