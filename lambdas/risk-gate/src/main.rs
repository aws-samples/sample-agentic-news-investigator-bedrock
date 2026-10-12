// SPDX-License-Identifier: MIT-0
use aws_lambda_events::event::eventbridge::EventBridgeEvent;
use fin_core::{detail_types, env_keys, sources, Action, RiskVerdict, TradeDecision};
use fin_store::audit::Stage;
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use rust_decimal::Decimal;

// Hard limits — deliberately conservative for the paper-test period.
const MIN_CONFIDENCE: f64 = 0.65;
const COOLDOWN_SECS: i64 = 3600;

fn max_order_notional() -> Decimal {
    Decimal::new(5_000, 0)
}
/// Prediction books are thin — tighter cap than equities/crypto.
fn max_prediction_notional() -> Decimal {
    Decimal::new(500, 0)
}
fn max_position_notional() -> Decimal {
    Decimal::new(10_000, 0)
}
fn max_daily_loss() -> Decimal {
    Decimal::new(-2_500, 0)
}
/// Fraction of total value that may be deployed across all positions (0.5).
fn max_gross_exposure_ratio() -> Decimal {
    Decimal::new(5, 1)
}

struct Ctx {
    store: Store,
    events: aws_sdk_eventbridge::Client,
    ssm: aws_sdk_ssm::Client,
    bus: String,
    kill_switch_param: String,
}

/// Returns Some((rule, detail)) on the first failed check, None if all pass.
async fn check(ctx: &Ctx, d: &TradeDecision) -> Result<Option<(String, String)>, Error> {
    // 1. Kill switch (read fresh every invocation — volume is tiny).
    let kill = ctx
        .ssm
        .get_parameter()
        .name(&ctx.kill_switch_param)
        .send()
        .await?
        .parameter
        .and_then(|p| p.value)
        .unwrap_or_else(|| "false".into());
    if kill.trim() == "true" {
        return Ok(Some(("kill_switch".into(), "kill switch is on".into())));
    }

    // 2. Sanity on the decision itself.
    if d.action == Action::Hold {
        return Ok(Some(("hold".into(), "hold decisions are not orders".into())));
    }
    if d.confidence < MIN_CONFIDENCE {
        return Ok(Some((
            "min_confidence".into(),
            format!("confidence {} < {}", d.confidence, MIN_CONFIDENCE),
        )));
    }
    if d.notional_usd <= Decimal::ZERO {
        return Ok(Some(("zero_notional".into(), "non-positive notional".into())));
    }
    if d.notional_usd > max_order_notional() {
        return Ok(Some((
            "max_order".into(),
            format!("notional {} > {}", d.notional_usd, max_order_notional()),
        )));
    }
    if d.asset_class == fin_core::AssetClass::Prediction
        && d.notional_usd > max_prediction_notional()
    {
        return Ok(Some((
            "max_prediction".into(),
            format!(
                "prediction notional {} > {}",
                d.notional_usd,
                max_prediction_notional()
            ),
        )));
    }

    let portfolio = ctx
        .store
        .get_portfolio()
        .await
        .map_err(|e| Error::from(e.to_string()))?;

    // 3. Daily loss cap.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    if portfolio.day_key == today && portfolio.realized_pnl_today <= max_daily_loss() {
        return Ok(Some((
            "daily_loss".into(),
            format!("realized {} today", portfolio.realized_pnl_today),
        )));
    }

    if d.action == Action::Buy {
        // 4. Cash + gross exposure: total deployed (incl. this order) must
        // stay under the exposure ratio of total equity-ish value (cash proxy).
        if d.notional_usd > portfolio.cash {
            return Ok(Some((
                "insufficient_cash".into(),
                format!("notional {} > cash {}", d.notional_usd, portfolio.cash),
            )));
        }
        let positions = ctx
            .store
            .list_positions()
            .await
            .map_err(|e| Error::from(e.to_string()))?;
        let deployed: Decimal = positions.iter().map(|p| p.qty * p.avg_cost).sum();
        let total_value = portfolio.cash + deployed;
        if deployed + d.notional_usd > total_value * max_gross_exposure_ratio() {
            return Ok(Some((
                "max_exposure".into(),
                format!(
                    "deployed {} + order {} > {} of {}",
                    deployed,
                    d.notional_usd,
                    max_gross_exposure_ratio(),
                    total_value
                ),
            )));
        }

        // 5. Per-symbol position cap.
        let existing = positions
            .iter()
            .find(|p| p.symbol == d.symbol)
            .map(|p| p.qty * p.avg_cost)
            .unwrap_or_default();
        if existing + d.notional_usd > max_position_notional() {
            return Ok(Some((
                "max_position".into(),
                format!(
                    "position {} + order {} > {}",
                    existing,
                    d.notional_usd,
                    max_position_notional()
                ),
            )));
        }
    }

    // 6. Per-symbol cooldown, claimed last so rejected orders don't burn it.
    if !ctx
        .store
        .claim_cooldown(&d.symbol, COOLDOWN_SECS)
        .await
        .map_err(|e| Error::from(e.to_string()))?
    {
        return Ok(Some((
            "cooldown".into(),
            format!("{} traded within the last {}s", d.symbol, COOLDOWN_SECS),
        )));
    }

    Ok(None)
}

/// Rejections an operator should see at the production log level. Approvals,
/// low confidence and the per-symbol cooldown are the gate working as routine
/// filtering; everything else is a hard limit or a malformed decision.
fn rejection_needs_operator(rule: Option<&str>) -> bool {
    matches!(rule, Some(r) if !matches!(r, "min_confidence" | "cooldown"))
}

async fn handler(
    event: LambdaEvent<EventBridgeEvent<TradeDecision>>,
    ctx: &Ctx,
) -> Result<(), Error> {
    let decision = event.payload.detail;

    if !ctx
        .store
        .claim_dedupe("risk", &decision.id)
        .await
        .map_err(|e| Error::from(e.to_string()))?
    {
        tracing::info!(decision_id = decision.id, "already risk-checked, skipping");
        return Ok(());
    }

    let rejection = check(ctx, &decision).await?;
    let (detail_type, verdict) = match &rejection {
        None => (detail_types::TRADE_APPROVED, "approved"),
        Some(_) => (detail_types::TRADE_REJECTED, "rejected"),
    };

    let event_out = RiskVerdict {
        decision_id: decision.id.clone(),
        verdict: verdict.into(),
        rule: rejection.as_ref().map(|(r, _)| r.clone()),
        detail: rejection.as_ref().map(|(_, d)| d.clone()),
        checked_at: chrono::Utc::now(),
        decision: decision.clone(),
    };

    ctx.store
        .put_audit(&decision.news_id, Stage::Risk, &event_out)
        .await
        .map_err(|e| Error::from(e.to_string()))?;

    let out = ctx
        .events
        .put_events()
        .entries(
            aws_sdk_eventbridge::types::PutEventsRequestEntry::builder()
                .event_bus_name(&ctx.bus)
                .source(sources::RISK)
                .detail_type(detail_type)
                .detail(serde_json::to_string(&event_out)?)
                .build(),
        )
        .send()
        .await?;
    if out.failed_entry_count() > 0 {
        return Err("put_events failed for risk verdict".into());
    }
    let rule = event_out.rule.as_deref().unwrap_or("-");
    if rejection_needs_operator(event_out.rule.as_deref()) {
        // A hard limit tripped (kill switch, loss cap, exposure, size): visible at WARN.
        tracing::warn!(
            decision_id = decision.id,
            symbol = decision.symbol,
            verdict,
            rule,
            detail = event_out.detail.as_deref().unwrap_or("-"),
            "risk verdict emitted"
        );
    } else {
        tracing::info!(decision_id = decision.id, verdict, rule, "risk verdict emitted");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    fin_core::logging::init_tracing();

    let config = aws_config::load_from_env().await;
    let ctx = Ctx {
        store: Store::new(
            aws_sdk_dynamodb::Client::new(&config),
            std::env::var(env_keys::TABLE_NAME)?,
        ),
        events: aws_sdk_eventbridge::Client::new(&config),
        ssm: aws_sdk_ssm::Client::new(&config),
        bus: std::env::var(env_keys::BUS_NAME)?,
        kill_switch_param: std::env::var(env_keys::KILL_SWITCH_PARAM)?,
    };
    lambda_runtime::run(service_fn(|event| handler(event, &ctx))).await
}

#[cfg(test)]
mod tests {
    use super::rejection_needs_operator;

    #[test]
    fn hard_limits_log_at_warn_routine_filtering_does_not() {
        for r in ["kill_switch", "daily_loss", "max_exposure", "max_position", "max_order",
                  "max_prediction", "insufficient_cash", "zero_notional", "hold"] {
            assert!(rejection_needs_operator(Some(r)), "{r}");
        }
        assert!(!rejection_needs_operator(None));
        assert!(!rejection_needs_operator(Some("min_confidence")));
        assert!(!rejection_needs_operator(Some("cooldown")));
    }
}
