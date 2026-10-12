// SPDX-License-Identifier: MIT-0
use aws_lambda_events::event::eventbridge::EventBridgeEvent;
use chrono::Utc;
use fin_core::{detail_types, env_keys, ids, sources, Action, AssetClass, OrderFilled, RiskVerdict, Side};
use fin_md::{MdError, Quote, Router};
use fin_store::ledger::{next_avg_cost, realized_pnl};
use fin_store::audit::Stage;
use fin_store::{Store, StoreError};
use lambda_runtime::{service_fn, Error, LambdaEvent};
use rust_decimal::Decimal;

/// Equity quotes are delayed; refuse to fill on anything staler than this.
const MAX_QUOTE_AGE_SECS: i64 = 20 * 60;
/// Slippage floor when the source has no bid/ask spread.
const MIN_SLIPPAGE_BPS: i64 = 2;

struct Ctx {
    store: Store,
    router: Router,
    events: aws_sdk_eventbridge::Client,
    bus: String,
}

/// Prediction books are thin; paper fills cross the full spread to the
/// resting quote (buy at ask, sell at bid) so paper P&L doesn't flatter us.
fn prediction_fill_price(quote: &Quote, side: Side) -> Option<(Decimal, i64)> {
    let px = match side {
        Side::Buy => quote.ask?,
        Side::Sell => quote.bid?,
    };
    let slip = (px - quote.price).abs();
    let bps = if quote.price.is_zero() {
        0
    } else {
        ((slip / quote.price) * Decimal::new(10_000, 0))
            .round()
            .try_into()
            .unwrap_or(0)
    };
    Some((px, bps))
}

/// Adverse fill price: cross half the spread when known, else a bps floor.
fn fill_price(quote: &Quote, side: Side) -> (Decimal, i64) {
    let bps_floor = quote.price * Decimal::new(MIN_SLIPPAGE_BPS, 4);
    let half_spread = match (quote.bid, quote.ask) {
        (Some(b), Some(a)) if a > b => (a - b) / Decimal::TWO,
        _ => Decimal::ZERO,
    };
    let slip = half_spread.max(bps_floor);
    let price = match side {
        Side::Buy => quote.price + slip,
        Side::Sell => quote.price - slip,
    };
    let bps = if quote.price.is_zero() {
        0
    } else {
        ((slip / quote.price) * Decimal::new(10_000, 0))
            .round()
            .try_into()
            .unwrap_or(0)
    };
    (price, bps)
}

async fn handler(
    event: LambdaEvent<EventBridgeEvent<RiskVerdict>>,
    ctx: &Ctx,
) -> Result<(), Error> {
    let verdict = event.payload.detail;
    let d = &verdict.decision;

    let side = match d.action {
        Action::Buy => Side::Buy,
        Action::Sell => Side::Sell,
        Action::Hold => return Ok(()),
    };

    let quote = match ctx.router.get_quote(&d.symbol, d.asset_class).await {
        Ok(q) => q,
        // An opt-in price source the deployment has not enabled (fin_md::EnabledSources):
        // nothing to fill against, and retrying will not change that.
        Err(MdError::Disabled(source)) => {
            tracing::warn!(decision_id = d.id, symbol = d.symbol, source, "price source not enabled — dropped");
            ctx.store
                .put_audit(&d.news_id, Stage::Execution, &serde_json::json!({
                    "decision_id": d.id, "outcome": "dropped_source_disabled", "source": source,
                }))
                .await
                .map_err(|e| Error::from(e.to_string()))?;
            return Ok(());
        }
        Err(e) => return Err(Error::from(e.to_string())),
    };

    // Never fill an equity order against yesterday's close.
    if d.asset_class == AssetClass::Equity {
        let age = (Utc::now() - quote.as_of).num_seconds();
        if age > MAX_QUOTE_AGE_SECS {
            tracing::warn!(
                decision_id = d.id,
                symbol = d.symbol,
                age_secs = age,
                "stale quote — order dropped"
            );
            ctx.store
                .put_audit(&d.news_id, Stage::Execution, &serde_json::json!({
                    "decision_id": d.id, "outcome": "dropped_stale_quote", "quote_age_secs": age,
                }))
                .await
                .map_err(|e| Error::from(e.to_string()))?;
            return Ok(());
        }
    }

    let (price, slippage_bps) = if d.asset_class == AssetClass::Prediction {
        match prediction_fill_price(&quote, side) {
            Some(p) => p,
            None => {
                // No resting quote on the traded side → nothing to fill against.
                tracing::warn!(decision_id = d.id, symbol = d.symbol, "empty prediction book — dropped");
                ctx.store
                    .put_audit(&d.news_id, Stage::Execution, &serde_json::json!({
                        "decision_id": d.id, "outcome": "dropped_empty_book",
                    }))
                    .await
                    .map_err(|e| Error::from(e.to_string()))?;
                return Ok(());
            }
        }
    } else {
        fill_price(&quote, side)
    };
    if price <= Decimal::ZERO {
        return Err("non-positive fill price".into());
    }
    // Prediction contracts trade in whole units ($1 payoff each).
    let qty = if d.asset_class == AssetClass::Prediction {
        (d.notional_usd / price).floor()
    } else {
        (d.notional_usd / price).round_dp(8)
    };
    if qty.is_zero() {
        tracing::warn!(decision_id = d.id, "notional too small for one unit — dropped");
        return Ok(());
    }
    let notional = (qty * price).round_dp(2);

    let position = ctx
        .store
        .get_position(&d.symbol)
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    let (old_qty, old_avg) = position
        .map(|p| (p.qty, p.avg_cost))
        .unwrap_or((Decimal::ZERO, Decimal::ZERO));

    if side == Side::Sell && qty > old_qty {
        tracing::warn!(decision_id = d.id, "sell qty exceeds position — dropped");
        ctx.store
            .put_audit(&d.news_id, Stage::Execution, &serde_json::json!({
                "decision_id": d.id, "outcome": "dropped_oversell",
                "requested_qty": qty.to_string(), "position_qty": old_qty.to_string(),
            }))
            .await
            .map_err(|e| Error::from(e.to_string()))?;
        return Ok(());
    }

    let pnl = realized_pnl(side, qty, price, old_avg);
    let new_avg = next_avg_cost(side, old_qty, old_avg, qty, price);
    let portfolio = ctx
        .store
        .get_portfolio()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    let cash_after = match side {
        Side::Buy => portfolio.cash - notional,
        Side::Sell => portfolio.cash + notional,
    };

    let fill = OrderFilled {
        order_id: ids::order_id(),
        decision_id: d.id.clone(),
        symbol: d.symbol.clone(),
        asset_class: d.asset_class,
        side,
        qty,
        quote_price: quote.price,
        fill_price: price,
        slippage_bps,
        notional_usd: notional,
        quote_source: quote.source.to_string(),
        cash_after,
        filled_at: Utc::now(),
    };

    let day_key = Utc::now().format("%Y-%m-%d").to_string();
    match ctx
        .store
        .record_fill(&fill, new_avg, old_qty, pnl, &day_key)
        .await
    {
        Ok(()) => {}
        // Order item already exists → this decision already filled (replay).
        Err(StoreError::Condition(msg)) => {
            tracing::info!(decision_id = d.id, msg, "fill skipped (idempotent or concurrent)");
            return Ok(());
        }
        Err(e) => return Err(Error::from(e.to_string())),
    }

    ctx.store
        .put_audit(&d.news_id, Stage::Execution, &fill)
        .await
        .map_err(|e| Error::from(e.to_string()))?;

    let out = ctx
        .events
        .put_events()
        .entries(
            aws_sdk_eventbridge::types::PutEventsRequestEntry::builder()
                .event_bus_name(&ctx.bus)
                .source(sources::EXEC)
                .detail_type(detail_types::ORDER_FILLED)
                .detail(serde_json::to_string(&fill)?)
                .build(),
        )
        .send()
        .await?;
    if out.failed_entry_count() > 0 {
        return Err("put_events failed for OrderFilled".into());
    }
    tracing::info!(
        order_id = fill.order_id,
        symbol = fill.symbol,
        qty = %fill.qty,
        fill_price = %fill.fill_price,
        "order filled"
    );
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
        router: Router::new(fin_md::default_client()),
        events: aws_sdk_eventbridge::Client::new(&config),
        bus: std::env::var(env_keys::BUS_NAME)?,
    };
    lambda_runtime::run(service_fn(|event| handler(event, &ctx))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn quote(price: &str, bid: Option<&str>, ask: Option<&str>) -> Quote {
        Quote {
            symbol: "TEST".into(),
            asset_class: AssetClass::Crypto,
            price: Decimal::from_str(price).unwrap(),
            bid: bid.map(|b| Decimal::from_str(b).unwrap()),
            ask: ask.map(|a| Decimal::from_str(a).unwrap()),
            as_of: Utc::now(),
            source: "test",
        }
    }

    #[test]
    fn buy_fills_above_mid_with_spread() {
        let q = quote("100", Some("99"), Some("101"));
        let (price, bps) = fill_price(&q, Side::Buy);
        assert_eq!(price, Decimal::from_str("101").unwrap()); // half-spread = 1
        assert_eq!(bps, 100);
    }

    #[test]
    fn sell_fills_below_mid() {
        let q = quote("100", Some("99"), Some("101"));
        let (price, _) = fill_price(&q, Side::Sell);
        assert_eq!(price, Decimal::from_str("99").unwrap());
    }

    #[test]
    fn no_spread_uses_bps_floor() {
        let q = quote("100", None, None);
        let (price, bps) = fill_price(&q, Side::Buy);
        assert_eq!(price, Decimal::from_str("100.02").unwrap());
        assert_eq!(bps, 2);
    }
}
