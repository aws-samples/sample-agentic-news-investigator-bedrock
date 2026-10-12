// SPDX-License-Identifier: MIT-0
use ulid::Ulid;

pub fn news_id() -> String {
    format!("nws_{}", Ulid::new())
}

pub fn signal_id() -> String {
    format!("sig_{}", Ulid::new())
}

pub fn decision_id() -> String {
    format!("dcn_{}", Ulid::new())
}

pub fn order_id() -> String {
    format!("ord_{}", Ulid::new())
}
