# Operations

Day-2 notes for running the sample for more than an afternoon. The v1 pipeline is serverless
and needs nothing beyond the stack; everything below is about the agent arms (v2, v3, and any
arm you add), the daily letter and the dashboard, which are long-running processes you host.

## 1. What runs where

| Process | Kind | Command (compiled) | Needs |
|---|---|---|---|
| worker, one per agent arm | long-running loop: SQS poll + 5/15/60-minute passes | `node dist/worker.js` | the arm's env block (below), AWS credentials |
| daily letter | once a day, a few minutes | `node dist/daily-report.js` | read on the arm tables, Bedrock; `pandoc` for the DOCX copy, `weasyprint` + a CUPS printer only if printing |
| dashboard | on demand | `node dist/dashboard.js` → `http://127.0.0.1:4310` | read on the arm tables |
| A/B report | on demand | `node dist/report.js` | read on the arm tables |
| bench | on demand, minutes to an hour | `node dist/replay.js …` | the archive, replay queue, Bedrock |

Supervisor templates (launchd, systemd, Docker Compose — one service per arm) live in
[`ops/README.md`](../ops/README.md). The workers run **compiled JavaScript** (`npm run compile`
emits `dist/`); `tsx` is for hand runs only and is known to hang under some supervisors.

**Two rules that bite:**

1. After changing anything in `v2/src`, run `npm run build && npm test && npm run compile`,
   then **restart every worker that runs the same `dist/`** — v2 and v3 share it. Until the
   restart the old code keeps running.
2. **An environment change needs a full restart of the unit**, not a reload: under launchd
   that is `bootout` + `bootstrap` (a `kickstart` keeps the old environment), under systemd
   `daemon-reload` + `restart`, under Compose a `down` + `up`. SSM parameters (kill switch,
   budget) are the exception: they are re-read within 60 s without a restart.

### The env block per arm

The stack emits a ready env block per arm (`ArmsEnv` output). The essentials:

| Variable | Purpose |
|---|---|
| `V2_ARM` | arm key (`v2`, `v3`, or yours); log and transcript prefix, and the registry entry to read defaults from |
| `V2_TABLE`, `V2_QUEUE_URL`, `V2_TRANSCRIPT_BUCKET`, `V2_TAPE_TABLE` | the arm's table and queue, the private bucket, the shared tape |
| `V2_KILL_SWITCH_PARAM`, `V2_DAILY_BUDGET_PARAM` | the arm's SSM parameters |
| `V2_DRY_RUN` | `true` (code default: decide and audit, never fill) or `false` |
| `V2_WORLD_MODEL` | `1` for a world-model arm |
| `V2_MASTER_MODEL`, `V2_EFFORT`, `V2_MAX_TURNS`, `V2_MAX_INVESTIGATIONS_PER_DAY` | the decision layer's knobs |
| `V2_EDGAR_CONTACT` | a real address; the SEC fair-access identity for `read_source` and enrichment |
| `V2_WEB_SEARCH` | `nova` or `off` |
| `AWS_REGION`, `AWS_PROFILE` (or an instance role) | credentials |

Every variable and its default is documented in `v2/src/config.ts` and listed in
`.env.example`.

## 2. Seeding and resetting an arm

An arm's book is a `PORTFOLIO / SNAPSHOT` row plus a `STATE / INCEPTION` row. Seed once:

```bash
cd v2
npm run seed -- --arm v3 --cash 100000           # dry run: prints the rows it would write
npm run seed -- --arm v3 --cash 100000 --apply   # writes them
../scripts/seed-portfolio.sh 100000              # the pipeline arm (v1)
```

Seeding is idempotent (a conditional write; it fails if the book exists). Inception is
recorded at seed time and is deliberately *earlier* than the first fill: time spent in cash is
part of the arm's performance. To reset an arm, delete its table's rows (or the table) and seed
again — there is no in-place reset, by design.

## 3. Kill switch and budgets

Each arm has two SSM parameters. The scripts wrap `aws ssm put-parameter`:

```bash
./scripts/kill-switch.sh --arm v3 on|off|status   # an agent arm
./scripts/kill-switch.sh on|off|status            # the pipeline arm (v1)
aws ssm put-parameter --name /fin/v2/daily-budget-usd --value 40 --overwrite
```

What the kill switch does: the worker stops taking messages (they wait in the queue — four
days of retention), skips the watch pass and the curiosity pass, and logs that it is holding.
Parked orders are not retried while it is on. On release, anything in the queue older than
`V2_MAX_NEWS_AGE_HOURS` (6) is dropped and audited as `v2-skipped`; the rest is processed.
The v1 pipeline has its own switch (`/fin/kill-switch`), read by the risk gate.

What the budget does is in [COST.md](COST.md): a daily ceiling, a 20 % reserve for position
management, and a per-day investigation cap. When the breaker refuses an item the row says
why, and the letter's Coverage section and the dashboard's spend tile show it.

## 4. The daily letter

`npm run daily-report` (or the compiled entry) writes `v2/reports/<day>.md`, a `.docx` copy
via `pandoc` if installed, and a narrative-only PDF via `weasyprint`; see
[example-letter.md](example-letter.md) for what it looks like.

- **Window.** Each letter covers everything since the previous letter's window ended, read
  from the anchor row `REPORT / DAY#<day>` in the arm's table (fallbacks: the previous report
  file's modification time, then a trailing 24 h; capped at 72 h). Run it in the morning and
  it is mostly *yesterday's* trading; the letterhead states the window.
- **Anchors advance only on success.** A run whose narrative failed (the model returned an
  empty text, the deadline hit) does not advance the anchor, so the next run tells the whole
  period. `REPORT_DAY=YYYY-MM-DD` regenerates an old letter and never advances the anchor.
- **Retries.** The narrative streams with a 15-minute deadline and retries once at a lower
  reasoning effort (`V2_LETTER_EFFORT`, default high → medium on retry). An empty narrative
  throws rather than producing an empty page.
- **Printing is opt-in.** Nothing is printed unless `V2_PRINT=1` is set in that unit's
  environment; `V2_PRINTER` names a CUPS printer, otherwise the default is used. Only the
  narrative is printed, never the data appendix. Hand runs therefore never hit a paper tray.
- **Equity snapshots.** Each successful run writes `EQUITY / DAY#<day>#<arm>` for the equity
  chart. An arm that never gets a letter has no snapshots and the dashboard shows seed and
  live only.

The letter reads the pipeline arm (v1) as an optional reference; it runs fine without it.

## 5. The dashboard

`npm run compile && npm run dashboard` serves one page on `http://127.0.0.1:4310`
(`V2_DASHBOARD_PORT`). It is read-only, binds to loopback only, caches a snapshot and
re-reads every 90 s (`V2_DASHBOARD_REFRESH_SECS`) only while a page is open. It shows every
arm's book at liquidation value, the equity curve against SPY/QQQ/GLD/USO, spend against the
budget, the mandate meter, orders (parked, working, expired), the news flow by type, the
investigation feed, outcome scores, theses, corrections, gate rulings, and the letters.

Its **operations** cards probe the host: supervisor state, worker log tail, last letter,
printer. Those probes are platform-specific (launchd and CUPS on macOS, the journal on
systemd) and degrade to "not available" elsewhere; `V2_SUPERVISOR=launchd|systemd|none` and
`V2_WORKER_LOG` / `V3_WORKER_LOG` tell it where to look.

`npm run report` prints the same comparison as text, plus the v3 measurements.

## 6. Routine checks

A healthy arm, from outside the process:

| Signal | Healthy | Unhealthy |
|---|---|---|
| SQS `NumberOfEmptyReceives` on the arm queue | ~180/hour (an idle worker long-polls every 20 s) | 0 for an hour while `NumberOfMessagesSent` > 0: nobody is asking |
| SQS `ApproximateNumberOfMessagesVisible` | near zero | growing: the worker is down, stuck, or slower than the feed |
| DLQ depth | zero | anything: a message failed three times — read it |
| `SPEND / DAY#<today>` | rising with the day's investigations | flat during market hours (nothing passing triage, or the worker is down); at the ceiling (the breaker is on) |
| worker log | one line per news item, a line per investigation with turns and cost | silence, or a retry line every 30 s |
| `PENDING#` rows | a handful, each with a plausible expiry | many, or expiries in the past: the watch pass is not running |
| letter | one per day, narrative present, anchor advanced | missing or empty: see below |

## 7. Failure signatures

| What you see | What it usually is | What to do |
|---|---|---|
| Log fills with `CredentialsProviderError` (or `ExpiredToken`) every 30 s; queue depth grows | the credential chain lapsed — a short-lived profile expired, a credential process cannot refresh, an instance role is missing a permission | refresh the credentials; the worker recovers on its own; check the letter's Coverage section for the gap |
| Log is simply **silent**; `NumberOfEmptyReceives` drops to 0, then a burst of deletes | the host was asleep or offline; nothing failed | keep the host awake (AC power, no idle sleep) or move to an always-on instance; news older than 6 h at wake-up is dropped as `v2-skipped` |
| Queue depth grows while the log shows investigations | the feed is faster than one worker (a storm advisory stream, an after-hours filing dump) | normal for bursts; the queue buffers four days. If chronic, raise the triage threshold or accept the age gate |
| Every investigation is a **zero-confidence hold at $0.00** | the Agent SDK's bundled runtime does not know the master model (upgrade the SDK), or a tool schema the SDK cannot convert (only plain Zod; run `npx vitest run test/tools.test.ts`), or Bedrock model access is not granted | fix the cause; nothing is lost but the day's decisions |
| `web_search` fails with an access-denied error; runs marked degraded | missing `bedrock:InvokeTool` on the Nova grounding system tool, or Nova model access not enabled | add the IAM statement (ARCHITECTURE § 12) |
| Letter file exists but the narrative is missing, or the run threw "empty narrative" | the model spent its whole output budget thinking (`stop_reason max_tokens`) | the run retries at medium effort automatically; if it still fails, re-run with `REPORT_DAY=` after checking Bedrock |
| Many `dropped_stale_quote` after the US close | normal: the venue is closed, the orders parked and will fill at the open | nothing; check `PENDING#` next morning |
| `v2-watch-suppressed` rows with `kind: thin-book` | normal: a price flicker on a book too thin to transact against | nothing; the letter reports them as "not events" |
| All equity quotes unresolvable at once | the unofficial Yahoo endpoint changed or is rate-limiting | wait, or point the Yahoo module at the alternate host; the arms hold meanwhile |
| EDGAR returns 403 or 429 | missing or placeholder `V2_EDGAR_CONTACT`, or more than 10 requests/s | set a real contact; enrichment already limits itself to four concurrent reads |
| `v2-skipped` rows with "daily budget spent" or "news budget spent" | the breaker | raise the SSM budget consciously, or wait for the UTC day to roll |
| The same headline investigated several times | the in-memory dedupe reset with a restart, or the story arrived under different headlines from several outlets | expected after a restart; otherwise tune triage's `recent_investigations` handling |
| A fill you did not expect | check the `v2-decision` row's `dry_run` and `model`, then the transcript in S3 | if a rule was violated (a fill the code should have refused), reverse it at cost with `node dist/admin/unwind-legacy.js` — dry-run without `--confirm` |

## 8. The bench, operationally

`npm run replay -- --name <bench> --max <n> --days <d> --end-days-ago <e> --variants live,no-mandate`

- It briefly **enables** the replay rule, starts an EventBridge replay filtered to that rule,
  drains the replay queue, and disables the rule again. Live events cannot reach the live arms
  through this path, and replayed events carry a `replay-name` the live workers ignore.
- Always pass `--days` and `--end-days-ago`: two summaries with the same `window_days` can
  cover disjoint weeks. `--max` and `--budget-usd` are per variant.
- Bench spend lands under `SPEND#BENCH#<name>#<variant>`, never in the live daily budget; bench
  audit rows under `BENCH#`; results in `BENCHSUM`.
- **Never publish synthetic events onto the live bus or an arm's queue** to "test" a worker.
  The reference deployment did that once and got a real paper fill and a book reset. The bench
  is the test path.

See [BENCHMARK.md](BENCHMARK.md) for the corpus-based bench and how to compare runs.

## 9. Data retention

| Data | Retention |
|---|---|
| bus archive | 90 days |
| SQS | 4 days (news), 1 day (replay), 14 days (DLQs) |
| archived bodies and transcripts (S3) | 30 days |
| quote tape | 90 days (TTL); table retained on stack deletion |
| arm tables | until you delete them (audit rows carry a TTL attribute where set) |
| letters | files in `v2/reports/`; keep or rotate as you like |

## 10. Upgrading models

Changing an arm's master model is one field in the arms registry plus a restart — with two
checks first: the account has Bedrock access to the model in every region the inference
profile can route to, and the pinned `@anthropic-ai/claude-agent-sdk` is new enough to know
the model (the failure mode is silent: zero-confidence holds at $0.00). Run one bench with
`--max 3` before letting the live arm loose on it. Non-Anthropic models are on the roadmap
(a Converse adapter), not supported today.

## 11. Opt-in data sources

Seven sources ship **off** ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) quotes the terms
as reviewed on 2026-10-07). The terms of Yahoo, Kalshi, CoinDesk and Cointelegraph do not permit
this sample's use without your own permission. Coinbase's, Polymarket's and GlobeNewswire's
could not be retrieved, and investingLive's do not address automated use, so those are off as a
precaution. A disabled source makes no network call. On by default: SEC EDGAR, USGS, NOAA NHC,
GDACS, the Federal Reserve and ECB press feeds, Kraken and CriptoYa.

| Source | What it supplies | Enable it in v1 (CDK) | Enable it in v2/v3 (worker env) |
|---|---|---|---|
| `yahoo` (Yahoo Finance chart endpoints) | equities, ETFs, ADRs, international listings and futures; the FX reference behind Kraken; long-tail crypto; the SPY/QQQ/GLD/USO comparison in the letter, dashboard and leaderboard; the bench's historical bars | `-c enableSources=yahoo` | `V2_ENABLE_SOURCES=yahoo` |
| `kalshi` (Kalshi market data) | Kalshi prediction contracts | `-c enableSources=kalshi` | `V2_ENABLE_SOURCES=kalshi` |
| `polymarket` (Polymarket Gamma API) | Polymarket contracts, `search_markets`, settlement of held contracts | `-c enableSources=polymarket` | `V2_ENABLE_SOURCES=polymarket` |
| `coinbase` (Coinbase spot prices) | crypto fallback behind Kraken | `-c enableSources=coinbase` | `V2_ENABLE_SOURCES=coinbase` |
| `crypto-news` (CoinDesk and Cointelegraph RSS) | crypto news items on the bus; every arm sees them | `-c enableSources=crypto-news` deploys `poller-crypto-news` and its schedule | nothing to set: the worker reads whatever is on the bus |
| `globenewswire` (GlobeNewswire RSS) | public-company press releases on the bus | `-c enableSources=globenewswire` deploys `poller-prwire` and its schedule | nothing to set |
| `investinglive` (investingLive RSS) | FX and macro wire headlines (the Fed and ECB feeds in the same poller always run) | `-c enableSources=investinglive` | nothing to set |

Combine names with commas, e.g. `cdk deploy -c contactEmail=… -c enableSources=yahoo,kalshi`
and `V2_ENABLE_SOURCES=yahoo,kalshi`. The v1 Lambdas get the price sources and `investinglive` as
`ENABLE_SOURCES`. The workers are configured separately, so set both if you run both. An
unknown name fails `cdk synth`; the worker logs a warning and ignores it.

**Enable a source only if you hold the provider's permission**: a licence, a data agreement
or written consent. Kalshi, for example, limits its API to members trading on the exchange
and prohibits AI/ML use of its data.

### What runs without them

- **News**: SEC 8-Ks, earthquakes, tropical cyclones, GDACS alerts, and Fed and ECB press
  releases. No press-wire, FX-wire or crypto news.
- **Tradeable universe**: FX pairs and crypto that Kraken quotes, and USDT parallel rates
  (CriptoYa). Equities, ETFs, futures and prediction contracts do not resolve. The investigator prompt gets a "Price sources in this deployment" note so the
  agent does not spend turns on them, and `resolve_instrument` says which source is missing.
- **v1** cannot price equities or prediction contracts. The analysis agent's `get_quote` tool
  reports the source as not enabled and `search_markets` returns nothing; an order that still
  reaches execution is dropped and audited as `dropped_source_disabled`. Its crypto trades
  are unaffected.
- **Benchmark comparison** (SPY, QQQ, GLD, USO) is empty in the letter, dashboard and
  leaderboard.
- **The bench** prices events as-of from the quote tape, which your deployment records from
  its first day, and otherwise from Yahoo history. Without Yahoo, events older than your tape
  cannot be priced. A corpus built with `bench:build` runs, but its equity decisions cannot
  be priced, so nearly everything it produces is a hold or an unpriced trade.

### Plugging in a licensed price source

The resolver is the only price oracle, so a replacement goes in one place per arm.

- **v2/v3**: add a module under `v2/src/quotes/` that returns a `Quote` (`types.ts`: price,
  `bid`/`ask` when you have a book, `asOfMs`, `source`, and `liquidityUsd` when you know the
  depth), and call it from the matching `case` in `quotes/resolver.ts`. For example, for
  equities, before or instead of `yahooEquityQuote`. Bid/ask and depth make fills more
  realistic: without them the fill is the 2 bps adverse default and the liquidity cap does
  not apply. If the feed has history, give `quotes/asof.ts` a bars function with the
  `yahooBars` signature (`deps.bars`) so the bench can price as-of. Give `performance.ts` and
  `books.ts` a daily-closes function with the `yahooDailyCloses` signature for the benchmark
  comparison. Put credentials in the worker's environment or Secrets Manager, never in the
  repository, and add a row to THIRD_PARTY_NOTICES.md.
- **v1**: implement `fin_md::QuoteSource` for the new feed in `crates/fin-md/src/` and route
  the asset class to it in `Router::get_quote` (`lib.rs`).

Run `npm test` and `cargo test --workspace`, then a short bench (`--max 3`), before pointing
a live arm at it.
