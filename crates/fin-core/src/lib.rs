// SPDX-License-Identifier: MIT-0
pub mod events;
pub mod ids;
pub mod logging;

pub use events::*;

/// Environment variable names shared by every lambda.
pub mod env_keys {
    pub const TABLE_NAME: &str = "TABLE_NAME";
    pub const BUS_NAME: &str = "BUS_NAME";
    pub const BODY_BUCKET: &str = "BODY_BUCKET";
    pub const MODEL_ID: &str = "MODEL_ID";
    pub const KILL_SWITCH_PARAM: &str = "KILL_SWITCH_PARAM";
}

/// EventBridge `source` values.
pub mod sources {
    pub const INGEST_EDGAR: &str = "fin.ingest.edgar";
    pub const INGEST_PRWIRE: &str = "fin.ingest.prwire";
    pub const INGEST_CRYPTO: &str = "fin.ingest.crypto";
    pub const INGEST_DISASTER: &str = "fin.ingest.disaster";
    pub const INGEST_MACRO: &str = "fin.ingest.macro";
    pub const AGENT_TRIAGE: &str = "fin.agent.triage";
    pub const AGENT_ANALYSIS: &str = "fin.agent.analysis";
    pub const RISK: &str = "fin.risk";
    pub const EXEC: &str = "fin.exec";
}

/// EventBridge `detail-type` values.
pub mod detail_types {
    pub const NEWS_ITEM: &str = "NewsItem";
    pub const SIGNAL_CANDIDATE: &str = "SignalCandidate";
    pub const TRADE_DECISION: &str = "TradeDecision";
    pub const TRADE_APPROVED: &str = "TradeApproved";
    pub const TRADE_REJECTED: &str = "TradeRejected";
    pub const ORDER_FILLED: &str = "OrderFilled";
}
