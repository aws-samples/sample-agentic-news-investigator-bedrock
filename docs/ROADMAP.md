# Roadmap

Where this sample could go next. None of it is committed work; the items are here so readers
know what the reference implementation does *not* yet do, and so contributions have a place
to point. Ordering is rough priority.

## 1. Converse adapter for non-Anthropic models

Today the decision layer is the Claude Agent SDK routed through Bedrock, so the master model
must be an Anthropic model the SDK's bundled runtime knows. A second `Strategy`
(`strategy.ts` is the seam) that drives the same `fin` tool set through the Bedrock Converse
API would let an arm run any Bedrock model that supports tool use, with the same book context,
decision schema, audit rows and outcome scores — the comparison would then span vendors, not
just prompts. The tool contract is already model-agnostic (plain JSON schemas); what is
missing is the loop and the per-model rate table.

## 2. Bench-scoped world model

The bench runs the v3 code path with the *live* world model, which was written after the
events being replayed — a lookahead the as-of resolver and the sim book already avoid for
prices and positions. A `SimWorld` that starts empty (or from a snapshot as-of the window
start), takes the gate's writes in memory, and carries across events would make v3 variants
benchable on the same footing as v2 variants.

## 3. Intraday price history for the bench

The as-of resolver falls back from the quote tape to Yahoo bars — minute bars for recent
events, then hourly, then daily — and those carry no depth, so liquidity caps do not bind and
prediction-market quotes before tape capture began are unrecoverable. A persistent intraday
store fed by the tape (or a licensed history source) would give every bench event a book with
depth and spread, not just a price.

## 4. Venue-hours-aware order expiry

Parked orders expire after `V2_PENDING_EXPIRY_HOURS` of wall-clock time. An equity order
parked on a Friday evening therefore dies on Saturday afternoon, before the venue reopens, and
the agent's Friday decision is never expressed. Measure expiry in venue-open time (24 open
hours ≈ the next full session) using the session calendar `marketSessionContext` already knows,
for both the live watcher and the bench's `firstFillableMs`.

## 5. EC2 / systemd reference deployment

The reference experiment ran its workers on a workstation, and every gap in its coverage
record was the workstation: sleep, a lapsed credential process, a closed lid. The
`ops/systemd` and `ops/docker` templates exist; a CDK construct that launches a small Graviton
instance with an instance role scoped to one arm, Session Manager access, the units installed,
and the letter rendered on the box (with the PDF dropped in S3 for whoever wants to print it)
would make an arm survive without a laptop.

## 6. A dailies source that is not Yahoo

Yahoo Finance's chart endpoints are unofficial. They are the only source for equities,
futures, international listings and the FX reference, so a change on their side takes most of
the universe offline at once. A pluggable `QuoteSource` for an official or licensed dailies
and quotes feed — even one that covers US equities only — would remove the single point of
fragility from the resolver and from bench scoring.

## 7. Smaller items

- **Per-arm daily letters.** The letter reads one arm's table and reports directory; a
  world-model arm gets no letter of its own today.
- **Short-borrow realism.** Paper shorts on sub-dollar names hours from a trading halt always
  fill; a borrow-availability haircut by price and venue tier (or a refusal below a price)
  would keep the record honest.
- **Triage calibration.** Materiality scores are bimodal; anchored integer scoring, and
  recognising a merger closing (a 3.01 filed with 2.01/5.01) as "nothing left to trade", are
  bench-testable prompt changes.
- **Typed held positions for triage.** Pass `{symbol, kind, name}` rather than bare symbols so
  a futures code and a country name cannot be confused.
- **Per-arm event snapshots on the tape.** `EVENT#<news_id>` is keyed per event; when two arms
  process the same item the later writer wins.
- **The reporter → trader feedback loop.** Feeding the letter's concerns into the next daily
  review is cheap to build and deliberately *not* done: it would end the "unassisted" framing
  of the control arm. It belongs in a separate arm if anywhere.
- **Metering everything.** Triage, enrichment, the world-model judge and the letter are not
  counted by the spend breaker; per-model rates and persisted token usage close that gap.
