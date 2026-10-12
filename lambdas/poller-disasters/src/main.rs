// SPDX-License-Identifier: MIT-0
use chrono::{DateTime, Utc};
use fin_core::{env_keys, sources};
use fin_ingest::{FeedEntry, FeedPoller, NewsDraft, Publisher};
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};

/// M4.5+ worldwide, past hour — updated within ~1-5 min of a quake.
const USGS_FEED: &str =
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson";
/// Only quakes at/above this magnitude become NewsItems; smaller ones are
/// never market-relevant and would just burn triage calls.
const MIN_MAGNITUDE: f64 = 5.5;

/// GDACS: UN/EC multi-hazard alerts (floods, cyclones, eruptions), severity-scored.
const GDACS_FEED: &str = "https://www.gdacs.org/xml/rss.xml";
/// NHC active-cyclone feeds: every advisory/update for Atlantic + E. Pacific.
const NHC_FEEDS: &[&str] = &[
    "https://www.nhc.noaa.gov/index-at.xml",
    "https://www.nhc.noaa.gov/index-ep.xml",
];

struct Deps {
    store: Store,
    publisher: Publisher,
    http: reqwest::Client,
}

/// USGS GeoJSON → NewsItems. Returns count published.
async fn poll_usgs(deps: &Deps) -> Result<usize, Error> {
    let body: serde_json::Value = deps.http.get(USGS_FEED).send().await?.json().await?;
    let mut published = 0usize;
    for f in body
        .get("features")
        .and_then(|v| v.as_array())
        .unwrap_or(&vec![])
    {
        let props = &f["properties"];
        let Some(mag) = props["mag"].as_f64() else { continue };
        if mag < MIN_MAGNITUDE {
            continue;
        }
        let Some(id) = f["id"].as_str() else { continue };
        if !deps
            .store
            .claim_dedupe("disaster", id)
            .await
            .map_err(|e| Error::from(e.to_string()))?
        {
            continue;
        }
        let place = props["place"].as_str().unwrap_or("unknown location");
        let url = props["url"].as_str().unwrap_or_default();
        let ts = props["time"]
            .as_i64()
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(Utc::now);
        let tsunami = props["tsunami"].as_i64().unwrap_or(0) == 1;
        let headline = format!("EARTHQUAKE: M{mag:.1} {place}");
        let summary = format!(
            "USGS reports a magnitude {mag:.1} earthquake, {place}. Tsunami flag: {tsunami}. \
             Detected at {ts}. Details: {url}"
        );
        let entry = FeedEntry {
            source_id: id.to_string(),
            headline,
            summary: summary.clone(),
            url: url.to_string(),
            published_at: ts,
        };
        deps.publisher
            .publish_news(NewsDraft {
                source: sources::INGEST_DISASTER,
                source_family: "disaster",
                entry: &entry,
                full_text: &summary,
                tickers_hint: vec![],
                asset_class_hint: None,
            })
            .await
            .map_err(|e| Error::from(e.to_string()))?;
        published += 1;
    }
    Ok(published)
}

async fn handler(_event: LambdaEvent<serde_json::Value>, deps: &Deps) -> Result<serde_json::Value, Error> {
    let mut total = 0usize;

    match poll_usgs(deps).await {
        Ok(n) => {
            if n > 0 {
                tracing::info!(published = n, "USGS earthquakes");
            }
            total += n;
        }
        Err(e) => tracing::error!(error = %e, "USGS poll failed"),
    }

    // GDACS + NHC are plain RSS — reuse the shared poller. asset_class_hint
    // stays None: disaster events have no inherent asset class; the agents decide.
    let feed_poller = FeedPoller {
        http: &deps.http,
        store: &deps.store,
        publisher: &deps.publisher,
        source: sources::INGEST_DISASTER,
        source_family: "disaster",
        asset_class_hint: None,
    };
    for feed in std::iter::once(&GDACS_FEED).chain(NHC_FEEDS) {
        match feed_poller.poll(feed).await {
            Ok(n) => {
                if n > 0 {
                    tracing::info!(feed, published = n, "polled");
                }
                total += n;
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
    let deps = Deps {
        store: Store::new(
            aws_sdk_dynamodb::Client::new(&config),
            std::env::var(env_keys::TABLE_NAME)?,
        ),
        publisher: Publisher {
            events: aws_sdk_eventbridge::Client::new(&config),
            s3: aws_sdk_s3::Client::new(&config),
            bus_name: std::env::var(env_keys::BUS_NAME)?,
            body_bucket: std::env::var(env_keys::BODY_BUCKET)?,
        },
        http: reqwest::Client::builder()
            .user_agent("Mozilla/5.0 fin-paper-trader/0.1")
            .timeout(std::time::Duration::from_secs(15))
            .build()?,
    };
    lambda_runtime::run(service_fn(|event| handler(event, &deps))).await
}
