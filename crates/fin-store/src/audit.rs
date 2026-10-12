// SPDX-License-Identifier: MIT-0
use crate::{s, n, Store, StoreError};
use serde::Serialize;

const AUDIT_TTL_DAYS: i64 = 90;

/// Pipeline stage names recorded in the audit trail.
#[derive(Debug, Clone, Copy)]
pub enum Stage {
    Ingested,
    Triage,
    Analysis,
    Risk,
    Execution,
    ParseError,
}

impl Stage {
    fn as_str(&self) -> &'static str {
        match self {
            Stage::Ingested => "ingested",
            Stage::Triage => "triage",
            Stage::Analysis => "analysis",
            Stage::Risk => "risk",
            Stage::Execution => "execution",
            Stage::ParseError => "parse_error",
        }
    }
}

impl Store {
    /// One audit item per pipeline stage per news item:
    /// pk = NEWS#<news_id>, sk = EVT#<ts>#<stage>.
    pub async fn put_audit<T: Serialize>(
        &self,
        news_id: &str,
        stage: Stage,
        payload: &T,
    ) -> Result<(), StoreError> {
        let now = chrono::Utc::now();
        let ttl = now.timestamp() + AUDIT_TTL_DAYS * 86_400;
        let body = serde_json::to_string(payload)
            .map_err(|e| StoreError::Decode(e.to_string()))?;
        self.client
            .put_item()
            .table_name(&self.table)
            .item("pk", s(format!("NEWS#{news_id}")))
            .item(
                "sk",
                s(format!("EVT#{}#{}", now.to_rfc3339(), stage.as_str())),
            )
            .item("stage", s(stage.as_str()))
            .item("payload", s(body))
            .item("ttl", n(ttl))
            .send()
            .await
            .map_err(|e| StoreError::Ddb(e.into_service_error().to_string()))?;
        Ok(())
    }

    /// Recent audit entries for a news id (analysis agent tool).
    pub async fn get_audit_trail(
        &self,
        news_id: &str,
    ) -> Result<Vec<(String, String)>, StoreError> {
        let out = self
            .client
            .query()
            .table_name(&self.table)
            .key_condition_expression("pk = :pk AND begins_with(sk, :sk)")
            .expression_attribute_values(":pk", s(format!("NEWS#{news_id}")))
            .expression_attribute_values(":sk", s("EVT#"))
            .send()
            .await
            .map_err(|e| StoreError::Ddb(e.into_service_error().to_string()))?;
        Ok(out
            .items()
            .iter()
            .filter_map(|item| {
                Some((
                    crate::get_s(item, "stage")?,
                    crate::get_s(item, "payload")?,
                ))
            })
            .collect())
    }
}
