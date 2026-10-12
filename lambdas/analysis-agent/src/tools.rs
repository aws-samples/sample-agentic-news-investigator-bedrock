// SPDX-License-Identifier: MIT-0
use fin_core::AssetClass;
use fin_llm::ToolHandler;
use fin_md::Router;
use fin_store::Store;
use std::sync::Arc;

pub struct GetQuote {
    pub router: Arc<Router>,
}

#[async_trait::async_trait]
impl ToolHandler for GetQuote {
    fn name(&self) -> &str {
        "get_quote"
    }
    fn description(&self) -> &str {
        "Get the current market price for a symbol. Equity quotes may be delayed ~15 minutes."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "symbol": { "type": "string", "description": "Ticker (AAPL), crypto base (BTC), or prediction contract (market-slug:YES / KALSHI-TICKER:NO)" },
                "asset_class": { "type": "string", "enum": ["equity", "crypto", "prediction"] }
            },
            "required": ["symbol", "asset_class"]
        })
    }
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let symbol = input["symbol"].as_str().ok_or("missing symbol")?;
        let asset_class = match input["asset_class"].as_str() {
            Some("crypto") => AssetClass::Crypto,
            Some("prediction") => AssetClass::Prediction,
            _ => AssetClass::Equity,
        };
        let q = self
            .router
            .get_quote(symbol, asset_class)
            .await
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "symbol": q.symbol,
            "price": q.price.to_string(),
            "bid": q.bid.map(|b| b.to_string()),
            "ask": q.ask.map(|a| a.to_string()),
            "as_of": q.as_of.to_rfc3339(),
            "source": q.source,
        }))
    }
}

pub struct GetPosition {
    pub store: Arc<Store>,
}

#[async_trait::async_trait]
impl ToolHandler for GetPosition {
    fn name(&self) -> &str {
        "get_position"
    }
    fn description(&self) -> &str {
        "Get the current paper position for a symbol (qty and average cost). Returns qty 0 if none."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "symbol": { "type": "string" } },
            "required": ["symbol"]
        })
    }
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let symbol = input["symbol"].as_str().ok_or("missing symbol")?;
        match self.store.get_position(symbol).await.map_err(|e| e.to_string())? {
            Some(p) => Ok(serde_json::json!({
                "symbol": p.symbol, "qty": p.qty.to_string(), "avg_cost": p.avg_cost.to_string()
            })),
            None => Ok(serde_json::json!({ "symbol": symbol, "qty": "0", "avg_cost": null })),
        }
    }
}

pub struct GetPortfolio {
    pub store: Arc<Store>,
}

#[async_trait::async_trait]
impl ToolHandler for GetPortfolio {
    fn name(&self) -> &str {
        "get_portfolio"
    }
    fn description(&self) -> &str {
        "Get portfolio cash balance, today's realized P&L, and all open positions."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }
    async fn run(&self, _input: serde_json::Value) -> Result<serde_json::Value, String> {
        let p = self.store.get_portfolio().await.map_err(|e| e.to_string())?;
        let positions = self.store.list_positions().await.map_err(|e| e.to_string())?;
        Ok(serde_json::json!({
            "cash": p.cash.to_string(),
            "realized_pnl_today": p.realized_pnl_today.to_string(),
            "positions": positions.iter().map(|pos| serde_json::json!({
                "symbol": pos.symbol, "qty": pos.qty.to_string(), "avg_cost": pos.avg_cost.to_string()
            })).collect::<Vec<_>>(),
        }))
    }
}

pub struct GetRecentEvents {
    pub store: Arc<Store>,
}

#[async_trait::async_trait]
impl ToolHandler for GetRecentEvents {
    fn name(&self) -> &str {
        "get_recent_events"
    }
    fn description(&self) -> &str {
        "Get the pipeline audit trail for this news item (prior triage/analysis stages)."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "news_id": { "type": "string" } },
            "required": ["news_id"]
        })
    }
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let news_id = input["news_id"].as_str().ok_or("missing news_id")?;
        let trail = self
            .store
            .get_audit_trail(news_id)
            .await
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!(trail
            .iter()
            .map(|(stage, payload)| serde_json::json!({ "stage": stage, "payload": payload }))
            .collect::<Vec<_>>()))
    }
}

pub struct SearchMarkets {
    pub http: reqwest::Client,
}

#[async_trait::async_trait]
impl ToolHandler for SearchMarkets {
    fn name(&self) -> &str {
        "search_markets"
    }
    fn description(&self) -> &str {
        "Search open prediction markets (Polymarket) by free text, e.g. 'hurricane landfall Florida' or 'earthquake Japan'. Returns tradable symbols with current YES prices. Use the returned symbol with get_quote (asset_class 'prediction') for live bid/ask."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
            },
            "required": ["query"]
        })
    }
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let query = input["query"].as_str().ok_or("missing query")?;
        let limit = input["limit"].as_u64().unwrap_or(5) as usize;
        let hits = fin_md::search_markets(&self.http, query, limit)
            .await
            .map_err(|e| e.to_string())?;
        Ok(serde_json::json!({ "markets": hits }))
    }
}

pub struct GetNewsBody {
    pub s3: aws_sdk_s3::Client,
}

#[async_trait::async_trait]
impl ToolHandler for GetNewsBody {
    fn name(&self) -> &str {
        "get_news_body"
    }
    fn description(&self) -> &str {
        "Fetch the full news article text given its s3:// URI (from body_s3_uri)."
    }
    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "s3_uri": { "type": "string" } },
            "required": ["s3_uri"]
        })
    }
    async fn run(&self, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let uri = input["s3_uri"].as_str().ok_or("missing s3_uri")?;
        let rest = uri.strip_prefix("s3://").ok_or("not an s3:// uri")?;
        let (bucket, key) = rest.split_once('/').ok_or("malformed s3 uri")?;
        let out = self
            .s3
            .get_object()
            .bucket(bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| e.into_service_error().to_string())?;
        let bytes = out.body.collect().await.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes.into_bytes()).to_string();
        // Keep tool results bounded; 16KB of body is plenty of context.
        Ok(serde_json::json!({ "text": text.chars().take(16_000).collect::<String>() }))
    }
}
