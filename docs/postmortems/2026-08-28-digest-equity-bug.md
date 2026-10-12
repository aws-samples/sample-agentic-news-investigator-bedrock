# 2026-08-28 — Digest under-reported equity (unpaginated DynamoDB scan)

## Symptom

The daily digest email showed equity dropping steadily from the $100k seed
down to $84,900.21, with no positions listed and realized P&L always $0 —
i.e. the system looked like it was consistently losing money.

## Actual state

It wasn't. As of 2026-08-28 the portfolio held $84,900.21 cash plus six open
positions (~$16.6k marked to market), for true equity of ~$101.5k: **+1.5%**
on the seed. All 8 lifetime fills were buys, so realized P&L really was $0.

| Position | Cost | MTM 2026-08-28 | P&L |
|---|---|---|---|
| ETH 2.4218 | $5,000 | $5,897 | +17.8% |
| BTC 0.0358 | $2,500 | $2,784 | +11.3% |
| RELY 103.84 | $2,500 | $2,754 | +9.8% |
| SITM 8.284 | $4,500 | $4,625 | +3.4% |
| fed-rate-hike-…:NO 943 | $500 | $467 | −6.6% |
| cat-4-hurricane-…:YES 400 | $100 | $62 | −38% |

## Root cause

`Store::list_positions` (`crates/fin-store/src/ledger.rs`) issued a single
DynamoDB `Scan` with a `begins_with(pk, "POSITION#")` filter and never
followed `LastEvaluatedKey`. A Scan page caps at 1MB of *scanned* data and
the filter applies after pagination. The table is dominated by news-audit
and dedupe items (16,430 items at the time), so the first page contained no
`POSITION#` rows and the call returned an empty list.

The original comment reasoned "positions are few, a scan is fine" — true of
the *result* size, but the page limit is driven by *table* size, which grows
with every polled news item. The bug therefore appeared only after enough
news had accumulated, and got deterministic as the table grew.

## Blast radius

- **digest**: market value = $0, so "Total equity" collapsed to cash and
  every buy read as a loss of exactly its notional. The `PortfolioEquity`
  CloudWatch metric and dashboard equity graph carried the same wrong number.
- **risk-gate**: the gross-exposure check computes "deployed" from
  `list_positions`, so the 50% max-exposure cap was silently a no-op.
  (Moot at ~15% deployed, but the control was dead.)
- `get_position` (point read) was unaffected, so per-position caps,
  cooldowns, and the ledger itself stayed correct.

## Fix

`list_positions` now walks all pages via `into_paginator()`. Deployed
2026-08-28; verified by direct invoke of the digest Lambda, which reported
all six positions and equity $101,489.48.

## Lessons

- Any DynamoDB `Scan`/`Query` with a filter must paginate; a filter never
  reduces the amount scanned per page.
- A "small result" argument doesn't justify an unpaginated scan on a table
  whose total size grows unboundedly.
- If positions ever become hot-path, move them to a `Query` (e.g. a shared
  `gsi1pk = "POSITIONS"`) instead of scanning past thousands of audit items.

## Open follow-up

The analysis agent has never emitted a sell — there is no exit/position-review
trigger, so positions only accumulate until the (now functional) exposure cap
blocks new entries. Realized P&L stays $0 until exits exist.
