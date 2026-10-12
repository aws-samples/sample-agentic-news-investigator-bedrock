# Cost

The trading is simulated; the model calls are not. **LLM spend is the one place this sample
touches real money**, and it is the reason the code has a spend breaker, a kill switch and a
dry-run default. Read this before running a worker for more than an hour.

> Headline: at 2026 list prices, an agent arm that investigates 100 or more news items a day
> costs **tens of dollars a day**. A quiet day with twenty investigations is a few dollars;
> a storm-advisory day can hit whatever ceiling you set. The figure depends on news volume,
> the master model, reasoning effort and turn budget far more than on anything in AWS.

## What costs money

| Item | Where | Per unit (order of magnitude) | Metered by the breaker? |
|---|---|---|---|
| **Investigation** — master model tokens across the agent loop | `investigate.ts` | roughly $0.35–$1.50 per investigation at 6–15 turns with the default high effort; the code prices Bedrock output with the rates in `config.ts` → `fable` when the SDK cannot | **yes** (`SPEND / DAY#`) |
| **Web search** — Nova web grounding | `websearch.ts` | one grounding request fee plus Nova 2 Lite tokens, about three cents per `web_search` call; an investigation makes zero to a handful | **yes** (folded into the investigation) |
| **Triage** — one Haiku call per news item that survives dedupe | `triage.ts` | fractions of a cent each; a few hundred items a day | no (small, but not zero: roughly a dollar a day at a few hundred items) |
| **8-K enrichment** — one Haiku call per SEC filing | `enrich.ts` | fractions of a cent each; 100–200 filings on a US trading day | no |
| **World-model judge** (v3) — one Haiku call per proposed causal link | `gate.ts` | fractions of a cent | no |
| **Daily letter** — one long streamed completion of the master model | `daily-report.ts` | a few dollars per letter at high effort with a 64k-token output ceiling | no (reported in the letter's own appendix as "real cost of running the agent" from the metered rows) |
| **AWS infrastructure** — DynamoDB on-demand, SQS, Lambda, EventBridge (+ archive), S3, SSM, CloudWatch | `infra/` | pennies to a few dollars a month at this event rate; the v1 pipeline's Sonnet analysis calls are its largest line | no |
| **Bedrock guardrail** (optional; off unless configured) — billed per text unit of up to 1,000 characters, per policy that evaluates | `infra/lib/guardrail.ts`, `v2/src/guardrail*.ts`, `crates/fin-llm/src/guardrail.rs` | the investigator dominates: about **$0.30–$0.55 per investigation**, see *Guardrail costs* below; triage, enrichment and tool-output screening are fractions of a cent per call | no |
| **Bench** — same as an investigation, per variant | `replay.ts` | a 20-investigation, two-variant run costs on the order of $15 | yes, under its own scope `SPEND#BENCH#<name>#<variant>` with its own `--budget-usd` |

Per-model metering with a rate table and persisted token usage (so triage and enrichment can
be counted too) is added by the runtime package; until then the unmetered lines above are a
small undercount.

## The spend breaker

`budget.ts` is the only hard breaker in the agent arms, and it is deliberately simple:

1. **Daily ceiling** — an SSM parameter per arm, `/<prefix>/<arm>/daily-budget-usd`, read
   every 60 s. The stack creates it with a low default; raise it consciously.
2. **Reserve** — news investigations stop at 80 % of the ceiling
   (`V2_BUDGET_RESERVE_FRACTION`, 0.2). Only position management (alerts, the daily review,
   curiosity) may spend the last 20 %, so a flood of news can never leave the agent unable to
   look at a position that is moving.
3. **Per-day investigation cap** — `V2_MAX_INVESTIGATIONS_PER_DAY` (default 20 in code; the
   reference experiment ran at 200 with the ceiling doing the work).
4. **Per-run cap** — `V2_MAX_BUDGET_PER_RUN_USD` (3) and `V2_MAX_TURNS` (15) bound a single
   investigation.

When the breaker refuses, the item is audited as `v2-skipped` with the reason, and the letter
and dashboard report it under Coverage. Spend is tallied per UTC day under `SPEND / DAY#<day>`
in the arm's table; the dashboard's "LLM spend today" tile reads that row.

## Typical figures

From the reference experiment (one investigator arm, high effort, 15-turn budget, a
$100,000 paper seed):

- 20–50 investigations a day at **$0.50–$1.00 each** worked out to roughly **$15–$25 a day**.
- The busiest windows — an after-hours EDGAR dump plus a night of position alerts — ran
  **$35–$40 for ~47 investigations**.
- The one day a tropical-storm advisory stream triggered 173 investigations exhausted a $50
  ceiling before noon. That incident produced the reserve and the advisory-cycle dedupe.
- Cumulative spend after eleven days was under $200 for the arm, about 0.2 % of the paper
  equity it was managing — a useful ratio to print in the letter, and it does.

Scale linearly with the number of arms: two agent arms on the same news cost twice as much,
because each triages and investigates independently. The v1 pipeline adds a Sonnet call per
`SignalCandidate`, at a much lower rate because its triage threshold is higher.

## Guardrail costs

The Bedrock guardrail (`docs/THREAT_MODEL.md` M27; how to turn it on in
[`ops/README.md`](../ops/README.md#bedrock-guardrail)) is billed by Amazon Bedrock per **text
unit** — up to 1,000 characters — for each policy that evaluates it. At list price when this
was written, content filters (prompt attack included) cost about **$0.15 per 1,000 text
units**, sensitive-information filters about **$0.10 per 1,000**, and the managed word list
nothing; check the Amazon Bedrock pricing page before relying on these figures. fin's PII
filter evaluates output only, so inputs are charged for content filtering alone.

Where the units come from:

| Call | Evaluated | Units per call | Cost per call |
|---|---|---|---|
| v2/v3 triage, filing enrichment, v3 link judge | only the tagged untrusted text (headline + summary, filing text, the link question) | 1–25 | well under a cent |
| `read_source` / `web_search` result (ApplyGuardrail) | the result, in chunks of 25,000 characters, at most 4 chunks | 1–25 typically, 100 at most | under 1.5 cents |
| **Investigator** (Agent SDK) | the **whole input on every turn**: system prompt, book context and the conversation so far, because the Agent SDK cannot mark guard content | roughly 120–240 per turn at 30k–60k tokens of context, about 2,000–3,500 over a 15-turn run | **about $0.30–$0.55** |
| v1 triage | the feed text, as Converse guard content | 1–5 | negligible |
| v1 analysis (up to 8 turns) | every message, every turn (not the system prompt) | about 100 per signal | about 1.5 cents |

So with the guardrail on, an arm running 50 investigations a day adds roughly **$15–$27 a
day**, which is 30–100 % on top of the model spend for those investigations. Everything else
is a dollar or two a day at most. The reference deployment runs it in every arm and
accepts that cost; a bench run of the `guardrail` variant is billed the same way. The guardrail's bill is not metered by the spend breaker.

## How to cap it

| Lever | Effect |
|---|---|
| `aws ssm put-parameter --name /<prefix>/<arm>/daily-budget-usd --value 20 --overwrite` | the hard ceiling; takes effect within 60 s |
| `/<prefix>/<arm>/kill-switch` = `true` (`scripts/kill-switch.sh --arm <key> on`) | the worker stops investigating, watching and curiosity-looping; queued news waits |
| `V2_MAX_INVESTIGATIONS_PER_DAY` | a count cap independent of price |
| `V2_MAX_BUDGET_PER_RUN_USD`, `V2_MAX_TURNS` | bound one investigation |
| `V2_EFFORT=low|medium` | cheaper reasoning per turn (thinking is always on for the default master model; this is the depth knob) |
| `V2_TRIAGE_THRESHOLD` (0.45), `V2_HELD_TRIAGE_THRESHOLD` (0.35) | fewer items reach the investigator; note that triage materiality is bimodal, so the threshold is a coarse lever |
| `V2_WEB_SEARCH=off` | no grounding fees; investigations run degraded |
| `V2_DRY_RUN=true` (the code default) | decisions are audited but never filled — costs the same in tokens, risks nothing in the paper book |
| v1: `MATERIALITY_THRESHOLD` in `lambdas/triage-agent` | the pipeline's cost knob |
| CloudWatch `BedrockSpendBreaker` alarm | emails when Bedrock invocations exceed 500 in 24 h (adjust in `infra/lib/fin-stack.ts`) |

Any environment change to a worker needs a restart to take effect; SSM parameters do not.

## Bench costs

The bench pays for triage once per event (Haiku) and for each investigation per variant
(master model), with search off. Pass `--max <n>` (investigations per variant) and
`--budget-usd <n>` (per variant) on every run; three investigations cost under a dollar, and a
20-investigation comparison of two variants is about $15. Bench spend is recorded under its
own scope and never counts against the live daily ceiling. See
[BENCHMARK.md](BENCHMARK.md).

## Turning it off

Delete the launchd/systemd units or containers for the workers and the letter timer (see
[OPERATIONS.md](OPERATIONS.md)), then `cdk destroy` the stack. The quote-tape table is
retained on stack deletion by design and must be deleted by hand; everything else is removed.
