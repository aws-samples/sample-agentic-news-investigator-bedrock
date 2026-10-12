// SPDX-License-Identifier: MIT-0
pub mod audit;
pub mod dedupe;
pub mod ledger;

use aws_sdk_dynamodb::types::AttributeValue;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("dynamodb error: {0}")]
    Ddb(String),
    #[error("duplicate item")]
    Duplicate,
    #[error("condition failed: {0}")]
    Condition(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("decode error: {0}")]
    Decode(String),
}

pub struct Store {
    pub client: aws_sdk_dynamodb::Client,
    pub table: String,
}

impl Store {
    pub fn new(client: aws_sdk_dynamodb::Client, table: String) -> Self {
        Self { client, table }
    }
}

pub(crate) fn s(v: impl Into<String>) -> AttributeValue {
    AttributeValue::S(v.into())
}

pub(crate) fn n(v: impl ToString) -> AttributeValue {
    AttributeValue::N(v.to_string())
}

pub(crate) fn get_s(item: &std::collections::HashMap<String, AttributeValue>, key: &str) -> Option<String> {
    item.get(key).and_then(|v| v.as_s().ok()).cloned()
}

pub(crate) fn get_decimal(
    item: &std::collections::HashMap<String, AttributeValue>,
    key: &str,
) -> Option<rust_decimal::Decimal> {
    use std::str::FromStr;
    item.get(key)
        .and_then(|v| v.as_n().ok())
        .and_then(|s| rust_decimal::Decimal::from_str(s).ok())
}
