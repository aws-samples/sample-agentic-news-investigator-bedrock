// SPDX-License-Identifier: MIT-0
mod tools;

use aws_lambda_events::event::eventbridge::EventBridgeEvent;
use fin_core::{detail_types, env_keys, ids, sources, SignalCandidate, TradeDecision};
use fin_llm::{extract_json, prompts, Guardrail, LlmError, ToolLoop};
use fin_md::Router;
use fin_store::audit::Stage;
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use rust_decimal::Decimal;
use std::str::FromStr;
use std::sync::Arc;

const MAX_TOOL_ITERATIONS: usize = 8;

struct Ctx {
    store: Arc<Store>,
    router: Arc<Router>,
    bedrock: aws_sdk_bedrockruntime::Client,
    events: aws_sdk_eventbridge::Client,
    s3: aws_sdk_s3::Client,
    bus: String,
    model_id: String,
    /// Bedrock guardrail (GUARDRAIL_ID + GUARDRAIL_VERSION); `None` = unguarded.
    guardrail: Option<Guardrail>,
}

#[derive(serde::Deserialize)]
struct RawDecision {
    action: fin_core::Action,
    symbol: String,
    asset_class: fin_core::AssetClass,
    notional_usd: String,
    confidence: f64,
    time_horizon: String,
    rationale: String,
}

async fn handler(
    event: LambdaEvent<EventBridgeEvent<SignalCandidate>>,
    ctx: &Ctx,
) -> Result<(), Error> {
    let signal = event.payload.detail;

    if !ctx
        .store
        .claim_dedupe("analysis", &signal.id)
        .await
        .map_err(|e| Error::from(e.to_string()))?
    {
        tracing::info!(signal_id = signal.id, "already analyzed, skipping");
        return Ok(());
    }

    let tool_loop = ToolLoop {
        client: &ctx.bedrock,
        model_id: &ctx.model_id,
        system: prompts::ANALYSIS_SYSTEM,
        tools: vec![
            Box::new(tools::GetQuote { router: ctx.router.clone() }),
            Box::new(tools::GetPosition { store: ctx.store.clone() }),
            Box::new(tools::GetPortfolio { store: ctx.store.clone() }),
            Box::new(tools::GetRecentEvents { store: ctx.store.clone() }),
            Box::new(tools::GetNewsBody { s3: ctx.s3.clone() }),
            Box::new(tools::SearchMarkets { http: fin_md::default_client() }),
        ],
        max_iterations: MAX_TOOL_ITERATIONS,
        guardrail: ctx.guardrail.as_ref(),
    };

    let user = format!(
        "Signal (news_id: {}):\nHeadline: {}\nEvent type: {}\nSentiment: {:?}\nMateriality: {}\nTriage rationale: {}\nCandidate assets: {}\nFull body S3 URI: {}\n\nInvestigate and decide.",
        signal.news_id,
        signal.headline,
        signal.event_type,
        signal.sentiment,
        signal.materiality,
        signal.rationale,
        serde_json::to_string(&signal.assets)?,
        signal.body_s3_uri.as_deref().unwrap_or("none"),
    );

    let result = match tool_loop.run(&user).await {
        Ok(r) => r,
        Err(LlmError::GuardrailIntervened(msg)) => {
            // A block is a no-trade: no decision event, an audit row saying why.
            tracing::warn!(signal_id = signal.id, blocked = %msg, "guardrail blocked analysis; no trade");
            ctx.store
                .put_audit(&signal.news_id, Stage::ParseError, &serde_json::json!({
                    "stage": "analysis", "signal_id": signal.id,
                    "guardrail_intervened": true, "blocked_message": msg,
                    "error": "the Bedrock guardrail blocked the analysis; no trade",
                }))
                .await
                .map_err(|e| Error::from(e.to_string()))?;
            return Ok(());
        }
        Err(e) => {
            tracing::error!(error = %e, signal_id = signal.id, "tool loop failed");
            ctx.store
                .put_audit(&signal.news_id, Stage::ParseError, &serde_json::json!({
                    "stage": "analysis", "error": e.to_string(), "signal_id": signal.id,
                }))
                .await
                .map_err(|e| Error::from(e.to_string()))?;
            return Ok(());
        }
    };

    let raw: Option<RawDecision> = extract_json(&result.final_text)
        .and_then(|v| serde_json::from_value(v).ok());
    let Some(raw) = raw else {
        tracing::warn!(signal_id = signal.id, "analysis output not parseable — no decision");
        ctx.store
            .put_audit(&signal.news_id, Stage::ParseError, &serde_json::json!({
                "stage": "analysis", "signal_id": signal.id, "text": result.final_text,
            }))
            .await
            .map_err(|e| Error::from(e.to_string()))?;
        return Ok(());
    };

    let notional = Decimal::from_str(&raw.notional_usd).unwrap_or(Decimal::ZERO);
    let decision = TradeDecision {
        id: ids::decision_id(),
        signal_id: signal.id.clone(),
        news_id: signal.news_id.clone(),
        action: raw.action,
        symbol: raw.symbol,
        asset_class: raw.asset_class,
        notional_usd: notional,
        confidence: raw.confidence,
        time_horizon: raw.time_horizon,
        rationale: raw.rationale,
        model_id: ctx.model_id.clone(),
        created_at: chrono::Utc::now(),
    };

    // Full decision + tool transcript into the audit trail.
    ctx.store
        .put_audit(&signal.news_id, Stage::Analysis, &serde_json::json!({
            "decision": decision,
            "tool_transcript": result.transcript.iter().map(|(name, input, output)| {
                serde_json::json!({ "tool": name, "input": input, "output": output })
            }).collect::<Vec<_>>(),
        }))
        .await
        .map_err(|e| Error::from(e.to_string()))?;

    if decision.action == fin_core::Action::Hold {
        tracing::info!(signal_id = signal.id, "hold — no decision event");
        return Ok(());
    }

    let out = ctx
        .events
        .put_events()
        .entries(
            aws_sdk_eventbridge::types::PutEventsRequestEntry::builder()
                .event_bus_name(&ctx.bus)
                .source(sources::AGENT_ANALYSIS)
                .detail_type(detail_types::TRADE_DECISION)
                .detail(serde_json::to_string(&decision)?)
                .build(),
        )
        .send()
        .await?;
    if out.failed_entry_count() > 0 {
        return Err("put_events failed for TradeDecision".into());
    }
    tracing::info!(decision_id = decision.id, symbol = decision.symbol, "decision emitted");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    fin_core::logging::init_tracing();

    let config = aws_config::load_from_env().await;
    let ctx = Ctx {
        store: Arc::new(Store::new(
            aws_sdk_dynamodb::Client::new(&config),
            std::env::var(env_keys::TABLE_NAME)?,
        )),
        router: Arc::new(Router::new(fin_md::default_client())),
        bedrock: aws_sdk_bedrockruntime::Client::new(&config),
        events: aws_sdk_eventbridge::Client::new(&config),
        s3: aws_sdk_s3::Client::new(&config),
        bus: std::env::var(env_keys::BUS_NAME)?,
        model_id: std::env::var(env_keys::MODEL_ID)?,
        guardrail: Guardrail::from_env()?,
    };
    if let Some(g) = &ctx.guardrail {
        tracing::info!(guardrail = g.id, version = g.version, "bedrock guardrail on");
    }
    lambda_runtime::run(service_fn(|event| handler(event, &ctx))).await
}
