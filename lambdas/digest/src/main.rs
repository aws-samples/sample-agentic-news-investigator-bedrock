// SPDX-License-Identifier: MIT-0
use fin_core::env_keys;
use fin_md::Router;
use fin_store::Store;
use lambda_runtime::{service_fn, Error, LambdaEvent};
use rust_decimal::Decimal;

/// CloudWatch namespace for the equity metric. The stack sets it from its
/// `metricNamespace` context value; the default is the pre-parameterisation literal.
const METRIC_NAMESPACE_ENV: &str = "METRIC_NAMESPACE";
const DEFAULT_METRIC_NAMESPACE: &str = "Fin";

struct Ctx {
    store: Store,
    router: Router,
    cloudwatch: aws_sdk_cloudwatch::Client,
    sns: aws_sdk_sns::Client,
    topic_arn: String,
    metric_namespace: String,
}

async fn handler(_event: LambdaEvent<serde_json::Value>, ctx: &Ctx) -> Result<(), Error> {
    let portfolio = ctx
        .store
        .get_portfolio()
        .await
        .map_err(|e| Error::from(e.to_string()))?;
    let positions = ctx
        .store
        .list_positions()
        .await
        .map_err(|e| Error::from(e.to_string()))?;

    let mut lines = vec![format!("Cash: ${}", portfolio.cash.round_dp(2))];
    let mut market_value = Decimal::ZERO;
    for p in &positions {
        // Mark to market; fall back to cost basis if the quote fails.
        let (value, note) = match ctx
            .router
            .get_quote(&p.symbol, guess_asset_class(&p.symbol))
            .await
        {
            Ok(q) => (p.qty * q.price, format!("@ {} ({})", q.price, q.source)),
            Err(_) => (p.qty * p.avg_cost, "@ cost (quote unavailable)".into()),
        };
        market_value += value;
        lines.push(format!(
            "{}: {} {} = ${} (avg cost {})",
            p.symbol,
            p.qty.round_dp(6),
            note,
            value.round_dp(2),
            p.avg_cost.round_dp(2)
        ));
    }
    let equity = portfolio.cash + market_value;
    lines.push(format!("Total equity: ${}", equity.round_dp(2)));
    lines.push(format!(
        "Realized P&L today: ${}",
        portfolio.realized_pnl_today.round_dp(2)
    ));
    let summary = lines.join("\n");
    tracing::info!("{}", summary);

    ctx.cloudwatch
        .put_metric_data()
        .namespace(ctx.metric_namespace.as_str())
        .metric_data(
            aws_sdk_cloudwatch::types::MetricDatum::builder()
                .metric_name("PortfolioEquity")
                .value(equity.try_into().unwrap_or(0.0))
                .unit(aws_sdk_cloudwatch::types::StandardUnit::None)
                .build(),
        )
        .send()
        .await?;

    ctx.sns
        .publish()
        .topic_arn(&ctx.topic_arn)
        .subject("fin daily digest")
        .message(summary)
        .send()
        .await?;
    Ok(())
}

/// Crypto positions use base symbols (BTC, ETH); prediction contracts carry
/// a :YES/:NO suffix; everything else is an equity ticker. Cheap heuristic
/// good enough for the digest's mark-to-market.
fn guess_asset_class(symbol: &str) -> fin_core::AssetClass {
    const KNOWN_CRYPTO: &[&str] = &["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "LTC"];
    if symbol.contains(':') {
        fin_core::AssetClass::Prediction
    } else if KNOWN_CRYPTO.contains(&symbol) {
        fin_core::AssetClass::Crypto
    } else {
        fin_core::AssetClass::Equity
    }
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
        cloudwatch: aws_sdk_cloudwatch::Client::new(&config),
        sns: aws_sdk_sns::Client::new(&config),
        topic_arn: std::env::var("TOPIC_ARN")?,
        metric_namespace: std::env::var(METRIC_NAMESPACE_ENV)
            .unwrap_or_else(|_| DEFAULT_METRIC_NAMESPACE.to_string()),
    };
    lambda_runtime::run(service_fn(|event| handler(event, &ctx))).await
}
