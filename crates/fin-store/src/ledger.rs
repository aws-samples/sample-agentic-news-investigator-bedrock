// SPDX-License-Identifier: MIT-0
use crate::{get_decimal, get_s, n, s, Store, StoreError};
use aws_sdk_dynamodb::types::{Put, TransactWriteItem, Update};
use fin_core::{OrderFilled, Side};
use rust_decimal::Decimal;

#[derive(Debug, Clone)]
pub struct Position {
    pub symbol: String,
    pub qty: Decimal,
    pub avg_cost: Decimal,
}

#[derive(Debug, Clone)]
pub struct Portfolio {
    pub cash: Decimal,
    pub realized_pnl_today: Decimal,
    pub day_key: String,
}

impl Store {
    pub async fn get_position(&self, symbol: &str) -> Result<Option<Position>, StoreError> {
        let out = self
            .client
            .get_item()
            .table_name(&self.table)
            .key("pk", s(format!("POSITION#{symbol}")))
            .key("sk", s("-"))
            .send()
            .await
            .map_err(|e| StoreError::Ddb(e.into_service_error().to_string()))?;
        Ok(out.item.and_then(|item| {
            Some(Position {
                symbol: symbol.to_string(),
                qty: get_decimal(&item, "qty")?,
                avg_cost: get_decimal(&item, "avg_cost")?,
            })
        }))
    }

    pub async fn list_positions(&self) -> Result<Vec<Position>, StoreError> {
        // Positions are few, but the table is dominated by news/dedupe items
        // and a Scan page caps at 1MB *scanned* (filter applies after), so a
        // single page can miss every position. Walk all pages.
        let mut positions = Vec::new();
        let mut pages = self
            .client
            .scan()
            .table_name(&self.table)
            .filter_expression("begins_with(pk, :p)")
            .expression_attribute_values(":p", s("POSITION#"))
            .into_paginator()
            .send();
        while let Some(page) = pages.next().await {
            let page = page.map_err(|e| StoreError::Ddb(e.to_string()))?;
            positions.extend(page.items().iter().filter_map(|item| {
                Some(Position {
                    symbol: get_s(item, "pk")?.strip_prefix("POSITION#")?.to_string(),
                    qty: get_decimal(item, "qty")?,
                    avg_cost: get_decimal(item, "avg_cost")?,
                })
            }));
        }
        positions.retain(|p| !p.qty.is_zero());
        Ok(positions)
    }

    pub async fn get_portfolio(&self) -> Result<Portfolio, StoreError> {
        let out = self
            .client
            .get_item()
            .table_name(&self.table)
            .key("pk", s("PORTFOLIO"))
            .key("sk", s("SNAPSHOT"))
            .send()
            .await
            .map_err(|e| StoreError::Ddb(e.into_service_error().to_string()))?;
        let item = out
            .item
            .ok_or_else(|| StoreError::NotFound("PORTFOLIO snapshot (run seed-portfolio.sh)".into()))?;
        Ok(Portfolio {
            cash: get_decimal(&item, "cash")
                .ok_or_else(|| StoreError::Decode("portfolio.cash".into()))?,
            realized_pnl_today: get_decimal(&item, "realized_pnl_today").unwrap_or_default(),
            day_key: get_s(&item, "day_key").unwrap_or_default(),
        })
    }

    /// Per-symbol cooldown claim; Ok(false) means still cooling down.
    pub async fn claim_cooldown(
        &self,
        symbol: &str,
        window_secs: i64,
    ) -> Result<bool, StoreError> {
        let now = chrono::Utc::now().timestamp();
        let result = self
            .client
            .put_item()
            .table_name(&self.table)
            .item("pk", s(format!("COOLDOWN#{symbol}")))
            .item("sk", s("-"))
            .item("ttl", n(now + window_secs))
            // TTL deletion lags; enforce expiry in the condition itself.
            .condition_expression("attribute_not_exists(pk) OR #ttl < :now")
            .expression_attribute_names("#ttl", "ttl")
            .expression_attribute_values(":now", n(now))
            .send()
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(e) => {
                let svc = e.into_service_error();
                if svc.is_conditional_check_failed_exception() {
                    Ok(false)
                } else {
                    Err(StoreError::Ddb(svc.to_string()))
                }
            }
        }
    }

    /// Atomically record a fill: order (idempotent on decision_id),
    /// position update, cash/P&L update. Fails the whole txn if cash would
    /// go negative on a buy or qty negative on a sell.
    ///
    /// `new_avg_cost` is computed by the caller (weighted average — DynamoDB
    /// update expressions can't multiply); `expected_qty` is the position qty
    /// the caller read, used as an optimistic-concurrency guard.
    pub async fn record_fill(
        &self,
        fill: &OrderFilled,
        new_avg_cost: Decimal,
        expected_qty: Decimal,
        realized_pnl_delta: Decimal,
        day_key: &str,
    ) -> Result<(), StoreError> {
        let signed_qty = match fill.side {
            Side::Buy => fill.qty,
            Side::Sell => -fill.qty,
        };
        let cash_delta = match fill.side {
            Side::Buy => -fill.notional_usd,
            Side::Sell => fill.notional_usd,
        };

        let order_put = Put::builder()
            .table_name(&self.table)
            .item("pk", s(format!("ORDER#{}", fill.decision_id)))
            .item("sk", s("-"))
            .item("gsi1pk", s(format!("SYM#{}", fill.symbol)))
            .item("gsi1sk", s(format!("TS#{}", fill.filled_at.to_rfc3339())))
            .item("order_id", s(&fill.order_id))
            .item("payload", s(serde_json::to_string(fill).map_err(|e| StoreError::Decode(e.to_string()))?))
            .condition_expression("attribute_not_exists(pk)")
            .build()
            .map_err(|e| StoreError::Ddb(e.to_string()))?;

        let position_update = Update::builder()
            .table_name(&self.table)
            .key("pk", s(format!("POSITION#{}", fill.symbol)))
            .key("sk", s("-"))
            .update_expression(
                "SET qty = if_not_exists(qty, :zero) + :dq, \
                 avg_cost = :avg, updated_at = :ts",
            )
            // Optimistic concurrency: the caller computed new_avg_cost from a
            // read of qty; abort if another fill landed in between.
            .condition_expression(
                "(attribute_not_exists(qty) AND :eq = :zero) OR qty = :eq",
            )
            .expression_attribute_values(":dq", n(signed_qty))
            .expression_attribute_values(":zero", n(0))
            .expression_attribute_values(":avg", n(new_avg_cost))
            .expression_attribute_values(":eq", n(expected_qty))
            .expression_attribute_values(":ts", s(fill.filled_at.to_rfc3339()))
            .build()
            .map_err(|e| StoreError::Ddb(e.to_string()))?;

        // Condition expressions can't do arithmetic, so guard buys with
        // cash >= notional instead of cash + delta >= 0.
        let portfolio_update = Update::builder()
            .table_name(&self.table)
            .key("pk", s("PORTFOLIO"))
            .key("sk", s("SNAPSHOT"))
            .update_expression(
                "SET cash = cash + :dc, \
                 realized_pnl_today = if_not_exists(realized_pnl_today, :zero) + :pnl, \
                 day_key = :day",
            )
            .condition_expression(match fill.side {
                Side::Buy => "cash >= :need",
                Side::Sell => "attribute_exists(cash)",
            })
            .expression_attribute_values(":dc", n(cash_delta))
            .expression_attribute_values(":pnl", n(realized_pnl_delta))
            .expression_attribute_values(":zero", n(0))
            .expression_attribute_values(":day", s(day_key));
        let portfolio_update = if fill.side == Side::Buy {
            portfolio_update.expression_attribute_values(":need", n(fill.notional_usd))
        } else {
            portfolio_update
        }
        .build()
        .map_err(|e| StoreError::Ddb(e.to_string()))?;

        let result = self
            .client
            .transact_write_items()
            .transact_items(TransactWriteItem::builder().put(order_put).build())
            .transact_items(TransactWriteItem::builder().update(position_update).build())
            .transact_items(TransactWriteItem::builder().update(portfolio_update).build())
            .send()
            .await;

        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                let svc = e.into_service_error();
                let msg = svc.to_string();
                // TransactionCanceledException with ConditionalCheckFailed on the
                // order Put means this decision was already executed → idempotent no-op.
                if msg.contains("TransactionCanceled") || msg.contains("ConditionalCheckFailed") {
                    Err(StoreError::Condition(msg))
                } else {
                    Err(StoreError::Ddb(msg))
                }
            }
        }
    }
}

/// Average-cost realized P&L for a sell: (sell_price - avg_cost) * qty.
pub fn realized_pnl(side: Side, qty: Decimal, fill_price: Decimal, avg_cost: Decimal) -> Decimal {
    match side {
        Side::Buy => Decimal::ZERO,
        Side::Sell => (fill_price - avg_cost) * qty,
    }
}

/// Weighted-average cost after a fill. Sells keep the prior avg_cost;
/// buys blend the old basis with the new lot.
pub fn next_avg_cost(
    side: Side,
    old_qty: Decimal,
    old_avg: Decimal,
    fill_qty: Decimal,
    fill_price: Decimal,
) -> Decimal {
    match side {
        Side::Sell => old_avg,
        Side::Buy => {
            let new_qty = old_qty + fill_qty;
            if new_qty.is_zero() {
                Decimal::ZERO
            } else {
                (old_qty * old_avg + fill_qty * fill_price) / new_qty
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn sell_pnl_uses_avg_cost() {
        let pnl = realized_pnl(
            Side::Sell,
            Decimal::from_str("10").unwrap(),
            Decimal::from_str("110").unwrap(),
            Decimal::from_str("100").unwrap(),
        );
        assert_eq!(pnl, Decimal::from_str("100").unwrap());
    }

    #[test]
    fn avg_cost_blends_on_buy() {
        let avg = next_avg_cost(
            Side::Buy,
            Decimal::from_str("10").unwrap(),
            Decimal::from_str("100").unwrap(),
            Decimal::from_str("10").unwrap(),
            Decimal::from_str("110").unwrap(),
        );
        assert_eq!(avg, Decimal::from_str("105").unwrap());
    }

    #[test]
    fn avg_cost_unchanged_on_sell() {
        let avg = next_avg_cost(
            Side::Sell,
            Decimal::from_str("10").unwrap(),
            Decimal::from_str("100").unwrap(),
            Decimal::from_str("5").unwrap(),
            Decimal::from_str("110").unwrap(),
        );
        assert_eq!(avg, Decimal::from_str("100").unwrap());
    }

    #[test]
    fn buy_has_no_realized_pnl() {
        let pnl = realized_pnl(
            Side::Buy,
            Decimal::ONE,
            Decimal::ONE_HUNDRED,
            Decimal::ZERO,
        );
        assert_eq!(pnl, Decimal::ZERO);
    }
}
