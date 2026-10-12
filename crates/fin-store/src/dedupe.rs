// SPDX-License-Identifier: MIT-0
use crate::{s, n, Store, StoreError};
use sha2::{Digest, Sha256};

const DEDUPE_TTL_DAYS: i64 = 7;

pub fn dedupe_key(source_family: &str, source_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_family.as_bytes());
    hasher.update(b"|");
    hasher.update(source_id.as_bytes());
    hex::encode(hasher.finalize())
}

impl Store {
    /// Returns Ok(true) if this item is new (claimed), Ok(false) if already seen.
    pub async fn claim_dedupe(
        &self,
        source_family: &str,
        source_id: &str,
    ) -> Result<bool, StoreError> {
        let key = dedupe_key(source_family, source_id);
        let ttl = chrono::Utc::now().timestamp() + DEDUPE_TTL_DAYS * 86_400;
        let result = self
            .client
            .put_item()
            .table_name(&self.table)
            .item("pk", s(format!("DEDUPE#{key}")))
            .item("sk", s("-"))
            .item("ttl", n(ttl))
            .item("source_family", s(source_family))
            .item("source_id", s(source_id))
            .condition_expression("attribute_not_exists(pk)")
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_key_is_stable_and_distinct() {
        let a = dedupe_key("edgar", "0001-26-01");
        let b = dedupe_key("edgar", "0001-26-01");
        let c = dedupe_key("prwire", "0001-26-01");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
    }
}
