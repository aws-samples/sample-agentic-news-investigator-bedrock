# The replay bench: corpus, runs, compare

The bench answers one question: **given the same news, in the same order, against the same
prices, what does a decision layer do differently?** It is a relative instrument. It cannot
tell you whether an agent "makes money"; it can tell you whether prompt B traded more than
prompt A on identical inputs, what each paid for it, and what the market did next.

Paper trading only. Nothing here places, or can place, an order anywhere.

## What a run is

A run takes a set of archived `NewsItem`s and, for each decision-layer **variant**
(`v2/src/strategy.ts`: `live`, `no-mandate`, `terse`, `no-content-rule`, or one you add), walks them in
chronological order against a **simulated book** (`v2/src/bench/book.ts`, `bench/run.ts`):

- **Triage once.** Every item goes through the same pre-triage filing enrichment and Haiku
  triage the live worker uses. The verdicts are shared by all variants, so variants differ
  only in the decision layer, never in what they were shown.
- **Quotes are as-of the event** (`v2/src/quotes/asof.ts`). `resolve_instrument` and
  `search_markets` answer from the quote tape when it has a row at or before the event, else
  from the last *completed* Yahoo bar before the event — never from a live quote. Bars are
  stamped at their close and carry their span, so an hourly bar on a 24x7 venue is
  granularity, not staleness; a venue closed at event time parks the order and fills at the
  first fillable moment, as the live worker does.
- **The book carries.** Fills land on a `SimBook` seeded with `--seed-cash`; every later event
  sees the positions, cash, mandate utilisation and 72 h watchlist that resulted. Liquidity
  caps, reduce-only working exits and parked orders behave as they do live.
  `get_decision_history` sees only the run's own earlier decisions (live `THESIS#` rows hold
  rationales written *after* the event, which would be lookahead).
- **Web search is off.** The live web knows the future of an archived event. Primary sources
  stay on: an SEC filing addressed by accession and an archived S3 body are what the event
  pointed at when it was published; the event's live URL is refused.
- **Scoring.** Each investigation's primary action (the first trade, else the hold) is scored
  at 1 day and 7 days from as-of entry and exit prices (`historicalReturn`). A hold is scored
  as the counterfactual long on its `watch_symbol`, so restraint is measured too.
- **Isolation.** Audit rows live under `BENCH#<name>#…` and summaries under `BENCHSUM`
  (sort key `<name>#<variant>`), spend under `BENCH#<name>#<variant>`. No `NEWS#` scan, letter,
  dashboard budget derivation or live ledger ever sees them. Nothing is written to the quote
  tape during a bench.

## Two ways to feed it

### 1. From the EventBridge archive (needs AWS)

```bash
cd v2
npm run replay -- --name bench-w34 --days 7 --end-days-ago 7 --variants live,no-mandate --max 20
```

`replay.ts` starts an EventBridge replay of the 90-day `fin-events` archive into a dedicated,
normally disabled rule and queue, drains it, disables the rule, and runs the bench. Only
envelopes carrying `replay-name` are processed, so live events that leak in during the
seconds the rule is enabled are dropped. Because the rule and queue are shared, **one archive
bench at a time**. Always pass `--days` and `--end-days-ago`: two summaries with the same
`window_days` can cover disjoint weeks. Ending the window at least 7 days ago is what makes
the 7-day scores complete.

Archive delivery order varies between replays, so the events are put in canonical order
(published_at, then id) before anything else happens, and the run records the sha256 of that
canonical list as `corpus_items_hash`.

### 2. From a corpus file (no queue, no rule, runs in parallel)

A **corpus** (`v2/src/bench/corpus.ts`) is a JSONL file: one header line

```json
{"fin_corpus":1,"created_at":"…","source":"archive|sample","window":{"start":"…","end":"…"},"count":58,"note":"…"}
```

followed by one wire-shape `NewsItem` per line, in canonical order. Its identity is the sha256
of the file bytes, written alongside as `<file>.sha256` in `shasum` format.

```bash
# dump a window of the archive into a corpus (needs AWS; no triage, no model spend)
npm run bench:dump -- bench/corpus/w34.jsonl --days 7 --end-days-ago 7 [--public-domain]

# run the bench on it (needs Bedrock and price history only). Any number at once, distinct --name each.
npm run bench -- bench/corpus/w34.jsonl --name w34-live --variants live --max 20 --budget-usd 10
npm run bench -- bench/corpus/w34.jsonl --name w34-nm   --variants no-mandate --max 20 --budget-usd 10
```

Corpus mode never touches EventBridge or SQS: it reads the file, triages, runs the variants,
and writes `BENCH#`/`BENCHSUM` rows keyed by `--name`. Every `BENCHSUM` row records
`input: "corpus"`, `corpus_file`, `corpus_hash` (the file) and `corpus_items_hash` (the
canonical lines actually run, after `--max-events`). A run whose `--name#variant` already has
a summary fails before any spend unless you pass `--overwrite`. `--days`/`--end-days-ago` are
ignored: the window is the corpus's own. If the file no longer matches its `.sha256`, the run
warns and records the hash of what it actually read.

The other flags work in both modes: `--variants a,b`, `--max` (investigations per variant),
`--max-events` (chronological cap in corpus mode; arrival cap in archive mode), `--threshold`
(the triage bar under test), `--budget-usd` (per variant, never the live breaker),
`--seed-cash`.

### Comparing runs

```bash
npm run bench:compare                       # every BENCHSUM row, grouped by corpus
npm run bench:compare -- --names w34-live,w34-nm
npm run bench:compare -- --diff w34-live w34-nm#no-mandate [--all]
```

The table shows, per run: arm, `name#variant`, input, corpus hash prefix, date, events seen,
triage passes, decisions (with errored runs in parentheses), buy/sell/hold, filled, dropped,
mean 1-day and 7-day return of the trades, the holds' 1-day counterfactual, unscoreable
decisions, cost, and cost per decision. Rows that share a corpus prefix saw identical events
— compare those, not rows across different prefixes.

`--diff` prints a per-event table of what each run decided (action, symbol, confidence, size,
fill or drop reason, 1-day return) for every event where the two runs differ (`--all` shows
every event). It **refuses to diff runs whose corpus hashes differ** — including two runs on
the same file with different `--max-events` — because a per-event comparison across different
inputs is meaningless. A bare name means the `live` variant. The diff reads the `BENCH#` audit
rows of both runs (a filtered scan of the arm's table; a few seconds).

## Building a corpus

The repository ships **no corpus**: no dataset is distributed with it. Build one on your own
machine instead, either from public historical sources or from your own deployment's archive.

**From public sources, any past date range** (no deployment needed):

```bash
export V2_EDGAR_CONTACT=you@example.org   # SEC fair access: a contact the SEC can reach
npm run bench:build -- --from 2026-09-01 --to 2026-09-07 --out bench/corpus/w36.jsonl
#   [--sources usgs,edgar] [--edgar-per-day 25] [--min-magnitude 5.5] [--note "…"]
```

`bench:build` (`v2/src/bench/build-public-corpus.ts`, with the parsing in `public-corpus.ts`)
queries the USGS earthquake catalog and SEC EDGAR's daily form index. It writes the items in the
exact wire shape the live pollers publish:
- USGS: M5.5+ earthquakes, the same threshold as the poller.
- EDGAR: up to `--edgar-per-day` 8-Ks and 8-K/As from listed filers each business day, in
  accession order so a rebuild picks the same filings. Each item is stamped with EDGAR's
  acceptance time and carries the filing's items and its accession number, so `read_source`
  and filing enrichment read the real filing.

It makes about five requests a second to SEC (the limit is ten), at most 31 days per corpus,
and never touches AWS. NOAA hurricane advisories and GDACS alerts are not covered: their
archives have no date-range query. For those, dump from your own archive.

**From your own deployment's archive**, once it has been collecting news:

```bash
npm run bench:dump -- bench/corpus/my-week.jsonl --days 7 --end-days-ago 7 --public-domain
```

`--public-domain` keeps only `edgar` and `disaster` items and drops anything whose headline,
summary or URL carries a wire-service or crypto-press fingerprint. Do not redistribute a corpus
that contains `prwire`, `crypto` or `macro` items: their text belongs to the publishers.

Either way, the corpus is yours. `bench/corpus/` is git-ignored, so nothing you build is
committed by accident. Pricing the bench's decisions needs historical quotes: your own quote
tape covers what your deployment has observed, and anything older needs the opt-in `yahoo`
source or a licensed feed ([OPERATIONS.md § 11](OPERATIONS.md#11-opt-in-data-sources)).

Verify a corpus before quoting results from it:

```bash
cd v2/bench/corpus && shasum -a 256 -c w36.jsonl.sha256
```

## What a result can and cannot claim

**Can.** On identical inputs (same corpus hash, same `--max-events`, same threshold), variant
A and variant B differed in these decisions, filled this much, paid this much, and the market
subsequently moved this way relative to each decision. Triage is stochastic, so run the
comparison with `--max` large enough that a handful of investigations is not the whole story,
and repeat it: two runs of the *same* variant are the noise floor against which a difference
between variants must be read.

**Cannot.**

- **It is not a return.** The sim book starts from seed cash with no positions, theses or
  parked orders carried in; the window is days, not months; fills are modelled (adverse fill at
  max(half-spread, 2 bps), 25 % of visible depth), not executed.
- **Training cutoff may postdate the corpus.** A model that has read about the week being
  replayed knows how it ended. Search is off to remove the live web, but nothing removes the
  weights. Prefer windows after the model's cutoff; treat older windows as a mechanics check.
- **Tape coverage is forward-only from 2026-09-04.** Before that date there are no captured
  prediction-market or parallel-FX quotes, so decisions on those instruments are
  `unscoreable`; equities, ETFs, futures, FX and crypto resolve from Yahoo bars.
- **Yahoo bars carry no depth or spread.** Fills on bar-priced instruments take the 2 bps
  adverse model and the liquidity cap cannot bind, so the bench is kinder to size than the
  live book on thin names.
- **Search off means a hold can mean unresearchable**, not unattractive. The bench measures
  the degraded agent by design; a variant that leans on search will look worse here than live.
- **Errored investigations** (the runtime failed before the agent answered) are counted and
  costed but are not decisions; a run with many of them is a run to discard, not to read.

## What a run costs

Rough figures at the current models and defaults. Triage is Haiku at roughly a cent per item;
filing enrichment is another Haiku call per 8-K that has readable text (none in the synthetic
sample). Each investigation is one Agent SDK session on the master model, typically
$0.20–0.60 with the default turn budget (the 2026-09-04 validation benches cost under $1 for
three variants over 200 archived events with `--max 20`). So a 60-item corpus with `--max 20`
and two variants is on the order of $1–5, dominated by how many events clear triage. Nova web
grounding is never used in a bench. `--budget-usd` caps each variant independently and stops
the walk when spent; spend is recorded under `BENCH#<name>#<variant>` and never counts against
the live daily budget.

## Where things are

- `v2/src/replay.ts` — the CLI: archive mode, `--dump`, `--corpus`, `--compare`, `--diff`.
- `v2/src/bench/corpus.ts` — corpus format, canonical ordering, hashes, validation,
  public-domain filter, `toBenchEvent`.
- `v2/src/bench/compare.ts` — pure table and diff formatting over `BENCHSUM` and `BENCH#` rows.
- `v2/src/bench/run.ts`, `bench/book.ts` — the variant runner and the simulated book.
- `v2/src/strategy.ts` — the variants. Add one there; its name is what `--variants` takes.
- `v2/src/quotes/asof.ts` — as-of resolution; `v2/src/tape.ts` — the quote tape it reads.
- Tests: `v2/test/bench-corpus.test.ts`, `bench-compare.test.ts`, `bench-run.test.ts`,
  `bench-book.test.ts`, `asof.test.ts`, `tools-bench.test.ts`, `strategy.test.ts`.
