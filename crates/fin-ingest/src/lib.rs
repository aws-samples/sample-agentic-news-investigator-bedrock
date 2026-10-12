// SPDX-License-Identifier: MIT-0
use chrono::Utc;
use fin_core::{detail_types, ids, AssetClass, NewsItem};
use fin_store::Store;

pub const MAX_SUMMARY_BYTES: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("feed parse error: {0}")]
    Feed(String),
    #[error("store error: {0}")]
    Store(#[from] fin_store::StoreError),
    #[error("aws error: {0}")]
    Aws(String),
}

/// Truncate on a char boundary to at most `max` bytes.
pub fn truncate_summary(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[derive(Debug, Clone)]
pub struct FeedEntry {
    pub source_id: String,
    pub headline: String,
    pub summary: String,
    pub url: String,
    pub published_at: chrono::DateTime<Utc>,
}

pub fn parse_feed(body: &[u8]) -> Result<Vec<FeedEntry>, IngestError> {
    let feed = feed_rs::parser::parse(body).map_err(|e| IngestError::Feed(e.to_string()))?;
    Ok(feed
        .entries
        .into_iter()
        .filter_map(|e| {
            let headline = e.title.map(|t| t.content)?;
            let url = e
                .links
                .first()
                .map(|l| l.href.clone())
                .unwrap_or_default();
            let summary = e
                .summary
                .map(|s| strip_html(&s.content))
                .unwrap_or_default();
            let published_at = e.published.or(e.updated).unwrap_or_else(Utc::now);
            Some(FeedEntry {
                source_id: e.id,
                headline,
                summary,
                url,
                published_at,
            })
        })
        .collect())
}

/// Cheap tag stripper — enough for RSS description fields.
pub fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for c in input.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct Publisher {
    pub events: aws_sdk_eventbridge::Client,
    pub s3: aws_sdk_s3::Client,
    pub bus_name: String,
    pub body_bucket: String,
}

/// Everything needed to publish one news item.
pub struct NewsDraft<'a> {
    pub source: &'a str,
    pub source_family: &'a str,
    pub entry: &'a FeedEntry,
    pub full_text: &'a str,
    pub tickers_hint: Vec<String>,
    pub asset_class_hint: Option<AssetClass>,
}

impl Publisher {
    /// Store full body in S3 when it exceeds the summary budget, then
    /// publish the NewsItem to the bus. Returns the event as published.
    pub async fn publish_news(&self, draft: NewsDraft<'_>) -> Result<NewsItem, IngestError> {
        let NewsDraft {
            source,
            source_family,
            entry,
            full_text,
            tickers_hint,
            asset_class_hint,
        } = draft;
        let id = ids::news_id();
        let body_s3_uri = if full_text.len() > MAX_SUMMARY_BYTES {
            let key = format!(
                "{}/{}.txt",
                entry.published_at.format("%Y/%m/%d"),
                id
            );
            self.s3
                .put_object()
                .bucket(&self.body_bucket)
                .key(&key)
                .body(full_text.as_bytes().to_vec().into())
                .content_type("text/plain; charset=utf-8")
                .send()
                .await
                .map_err(|e| IngestError::Aws(e.into_service_error().to_string()))?;
            Some(format!("s3://{}/{}", self.body_bucket, key))
        } else {
            None
        };

        let item = NewsItem {
            id,
            source_family: source_family.to_string(),
            source_id: entry.source_id.clone(),
            published_at: entry.published_at,
            ingested_at: Utc::now(),
            headline: entry.headline.clone(),
            summary: truncate_summary(full_text, MAX_SUMMARY_BYTES),
            url: entry.url.clone(),
            body_s3_uri,
            tickers_hint,
            asset_class_hint,
        };

        let entry = aws_sdk_eventbridge::types::PutEventsRequestEntry::builder()
            .event_bus_name(&self.bus_name)
            .source(source)
            .detail_type(detail_types::NEWS_ITEM)
            .detail(serde_json::to_string(&item).map_err(|e| IngestError::Aws(e.to_string()))?)
            .build();
        let out = self
            .events
            .put_events()
            .entries(entry)
            .send()
            .await
            .map_err(|e| IngestError::Aws(e.into_service_error().to_string()))?;
        // PutEvents partial failures are silent unless you check the count.
        if out.failed_entry_count() > 0 {
            let detail = out
                .entries()
                .iter()
                .filter_map(|e| e.error_message().map(String::from))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(IngestError::Aws(format!("put_events failed: {detail}")));
        }
        Ok(item)
    }
}

/// Shared poller driver: fetch a feed URL, dedupe each entry, publish new ones.
pub struct FeedPoller<'a> {
    pub http: &'a reqwest::Client,
    pub store: &'a Store,
    pub publisher: &'a Publisher,
    pub source: &'static str,
    pub source_family: &'static str,
    pub asset_class_hint: Option<AssetClass>,
}

impl<'a> FeedPoller<'a> {
    pub async fn poll(&self, feed_url: &str) -> Result<usize, IngestError> {
        let resp = self.http.get(feed_url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(IngestError::Feed(format!("{feed_url}: HTTP {status}")));
        }
        let body = resp.bytes().await?;
        let entries = parse_feed(&body)?;
        let mut published = 0usize;
        for entry in entries {
            if !self
                .store
                .claim_dedupe(self.source_family, &entry.source_id)
                .await?
            {
                continue;
            }
            self.publisher
                .publish_news(NewsDraft {
                    source: self.source,
                    source_family: self.source_family,
                    entry: &entry,
                    full_text: &entry.summary,
                    tickers_hint: vec![],
                    asset_class_hint: self.asset_class_hint,
                })
                .await?;
            published += 1;
        }
        Ok(published)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html() {
        assert_eq!(
            strip_html("<p>Hello <b>world</b></p>\n  extra"),
            "Hello world extra"
        );
    }

    #[test]
    fn truncates_on_char_boundary() {
        let s = "aé".repeat(3000); // 3 bytes per pair
        let t = truncate_summary(&s, 4096);
        assert!(t.len() <= 4096);
        assert!(t.is_char_boundary(t.len()));
    }

    #[test]
    fn parses_minimal_rss() {
        let rss = br#"<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title>
<item><guid>g1</guid><title>Headline One</title><link>https://x.test/1</link>
<description>&lt;p&gt;Body text&lt;/p&gt;</description>
<pubDate>Thu, 31 Jul 2026 12:00:00 GMT</pubDate></item>
</channel></rss>"#;
        let entries = parse_feed(rss).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].headline, "Headline One");
        assert_eq!(entries[0].summary, "Body text");
    }
}
