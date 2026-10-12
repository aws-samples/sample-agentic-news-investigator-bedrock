// SPDX-License-Identifier: MIT-0
//! One tracing setup for every Lambda: JSON lines, no timestamp (CloudWatch
//! stamps each line), level from `RUST_LOG`, production default WARN.

use tracing_subscriber::EnvFilter;

/// Environment variable that sets the log level (`error|warn|info|debug|trace|off`,
/// or full `EnvFilter` directives such as `info,aws_smithy_runtime=warn`).
pub const LOG_LEVEL_ENV: &str = "RUST_LOG";

/// Level used when `RUST_LOG` is unset, empty or not understood.
pub const DEFAULT_LOG_LEVEL: &str = "warn";

const LEVELS: &[&str] = &["off", "error", "warn", "info", "debug", "trace"];

/// The filter directives to use for a raw `RUST_LOG` value. Anything that is
/// not a level name or a `target=level` directive falls back to WARN rather
/// than being read as a target name (which `EnvFilter` would accept and which
/// would silently turn logging off for everything else).
pub fn log_directives(raw: Option<&str>) -> String {
    let Some(v) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return DEFAULT_LOG_LEVEL.into();
    };
    let lower = v.to_ascii_lowercase();
    let parts_ok = lower
        .split(',')
        .map(str::trim)
        .all(|p| LEVELS.contains(&p) || (p.contains('=') && !p.starts_with('=')));
    if parts_ok && EnvFilter::builder().parse(&lower).is_ok() {
        lower
    } else {
        DEFAULT_LOG_LEVEL.into()
    }
}

/// Install the global subscriber. Call once, first thing in `main`.
pub fn init_tracing() {
    let raw = std::env::var(LOG_LEVEL_ENV).ok();
    let filter = EnvFilter::new(log_directives(raw.as_deref()));
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .without_time()
        .init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_or_empty_defaults_to_warn() {
        assert_eq!(log_directives(None), "warn");
        assert_eq!(log_directives(Some("")), "warn");
        assert_eq!(log_directives(Some("   ")), "warn");
    }

    #[test]
    fn level_names_pass_through_case_insensitively() {
        for l in ["error", "warn", "info", "debug", "trace", "off"] {
            assert_eq!(log_directives(Some(l)), l);
        }
        assert_eq!(log_directives(Some(" INFO ")), "info");
    }

    #[test]
    fn target_directives_are_accepted() {
        assert_eq!(
            log_directives(Some("info,aws_smithy_runtime=warn")),
            "info,aws_smithy_runtime=warn"
        );
        assert_eq!(log_directives(Some("risk_gate=debug")), "risk_gate=debug");
    }

    #[test]
    fn invalid_values_fall_back_to_warn() {
        assert_eq!(log_directives(Some("verbose")), "warn");
        assert_eq!(log_directives(Some("info,loud")), "warn");
        assert_eq!(log_directives(Some("foo=notalevel")), "warn");
        assert_eq!(log_directives(Some("=info")), "warn");
    }
}
