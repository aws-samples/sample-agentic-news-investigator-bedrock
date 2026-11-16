# The prediction desk and the fast desk

Two optional arm configurations of the Agent SDK investigator (`v2/`). Both are **paper
trading**, like every other arm, and both are off unless an arm's environment turns them on.
The existing arms are unaffected: with the flags unset their system prompts, tool schemas and
book contexts are byte-identical (`v2/test/prompts-arms.test.ts`).

| Configuration | Flags | What changes |
|---|---|---|
| **Prediction desk** | `V2_UNIVERSE=prediction` | The arm trades only Polymarket and Kalshi contracts, plus futures as a hedge (gross futures at most `V2_FUTURES_MAX_PCT` of equity, default 20%). Everything else is refused at execution (`universe.ts`). Triage uses a prediction-market prompt, the investigator gets the desk prompt and a `search_kalshi` tool, and a market-first **sweep** can run on a timer. |
| **Fast desk** | the above plus `V2_FAST_DESK=1` | Adds the fast-reaction package: a 1–24 hour horizon, a `fair_probability` on every decision with quarter-Kelly edge sizing, an exit plan (`exit_target`, `exit_stop`, `exit_by`) stored on the thesis with a one-shot time stop, contract alerts on the mid price, and quote-freshness and stop-early rules. |

## Before you enable it

Both venues are **opt-in data sources** and ship off. Kalshi's Developer Agreement limits API
use to a member's own trading and its Data Terms prohibit use with AI/ML systems; Polymarket's
terms could not be reviewed from the US ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
Enable a venue only if you hold its permission. With neither enabled the desk has nothing to
trade: no venue call is made and every contract fails to resolve.

## Set up a desk arm

1. **Add the arm** to `arms.json` (any key; `desk` is used below):

   ```json
   {
     "key": "desk",
     "kind": "agent",
     "label": "prediction desk",
     "model": "us.anthropic.claude-fable-5-1",
     "effort": null,
     "worldModel": false,
     "dailyBudgetUsd": 25,
     "maxInvestigationsPerDay": 100
   }
   ```

2. **Deploy** so the arm gets its queue, table, kill switch and budget:
   `cd infra && npx cdk deploy -c contactEmail=you@example.com -c enableSources=kalshi,polymarket`

3. **Seed** the paper book: `cd v2 && npm run seed -- --arm desk --cash 100000 --apply`

4. **Environment.** Start from the arm's block in the stack's `ArmsEnv` output and add:

   ```bash
   V2_ARM=desk
   V2_DRY_RUN=false                    # paper fills; the code default is dry-run
   V2_ENABLE_SOURCES=kalshi,polymarket # only with the venues' permission
   V2_UNIVERSE=prediction
   V2_FUTURES_MAX_PCT=0.20
   V2_SWEEP_INTERVAL_MIN=120           # market-first sweep every 2 h; 0 = off
   V2_KALSHI_FEES=1                    # charge Kalshi's taker fee on paper fills
   # the desk's mandate: more positions, a higher deployment band, a per-contract cap
   V2_MANDATE_MIN_DEPLOYED=0.50
   V2_MANDATE_MAX_DEPLOYED=0.85
   V2_MANDATE_MIN_POSITIONS=6
   V2_MANDATE_MAX_POSITIONS=20
   V2_MANDATE_MAX_POSITION=0.15
   # the fast desk
   V2_FAST_DESK=1
   # recommended guards (both off by default)
   V2_REVIEW_MANAGE_ONLY=1             # the daily review may exit, trim or hold, never open
   V2_MAX_NEW_EXPOSURE_PCT=6           # new exposure one decision may open, % of equity
   ```

5. **Run the worker** as for any arm ([OPERATIONS.md](OPERATIONS.md), `ops/`).

## Knobs

All are documented with their defaults in `v2/src/config.ts` and listed in `v2/.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `V2_UNIVERSE` | `all` | `prediction` turns the arm into the desk. |
| `V2_FUTURES_MAX_PCT` | `0.20` | Gross futures allowed on the desk, as a share of equity. |
| `V2_FAST_DESK` | off | The fast-reaction package. Only meaningful with `V2_UNIVERSE=prediction`. |
| `V2_SWEEP_INTERVAL_MIN` | `0` | Minutes between market-first sweeps (`sweep.ts`, trigger `sweep`): the most-traded open contracts plus recent news, one investigation. |
| `V2_KALSHI_FEES` | off | Fold Kalshi's taker fee, `0.07 × contracts × price × (1 − price)` rounded up per order, into paper fills. Leave it on for any desk whose results you intend to act on: the fee is a large share of a short-horizon desk's gross result. |
| `V2_KALSHI_CACHE` | `~/.cache/fin/kalshi-index.json` | The hourly index of open Kalshi events behind `search_kalshi`, shared by arms on one host. `off` keeps it per process. |
| `V2_TRIAGE_CONTRACTS` | off | Show triage the open contracts matching the item's subjects. Changes what triage admits; bench it first. |
| `V2_TRIAGE_HANDOFF` | off | Give the investigator triage's whole read, not only its hypotheses. |
| `V2_TRIAGE_BOOK` | off | Show triage the real book (side, size, one-line thesis) instead of bare symbols. |
| `V2_STORM_HOLD_SECS` | `0` | Hold a storm advisory cycle's products this long and triage the most informative one. |
| `V2_REVIEW_MANAGE_ONLY` | off | The daily review may not open or add. |
| `V2_MAX_NEW_EXPOSURE_PCT` | `0` | Per-decision cap on new exposure, % of equity. |
| `V2_WATCH_VOL_SIGMA` | `0` | Position-alert threshold scaled to the instrument's volatility (equities and futures). |
| `V2_DUST_USD` | `25` | Position lines below this are closed exactly on exit and left out of alerts and the book context. |
| `V2_SHADOW_KALSHI` | off | For every paper Kalshi trade, read the real order book and record what an immediate-or-cancel order would have got (`v2-shadow` audit rows). Observer only. |
| `V2_SIZING_MULTIPLIER` | `1` | Scales the equity the agent sizes against. See [LIVE_TRADING.md](LIVE_TRADING.md) before raising it. |

## What a desk decision looks like

Every trigger still goes through `pipeline.ts investigateAndAct`: news, a position alert, the
daily review, or a sweep. On the fast desk `submit_decision` carries four more fields
(`fair_probability`, `exit_target`, `exit_stop`, `exit_by`); they exist in the tool schema only
with `V2_FAST_DESK=1`. The exit plan is stored on the standing thesis, shown back in every
later book context, and `watch.ts` raises one alert when `exit_by` passes.

Prediction contracts are never shorted: the bearish expression is the `:NO` side. Settlement
is bookkeeping (`watch.ts`), written as a fill at 0 or 1.

## Bench

The replay bench runs the desk like any arm (`V2_UNIVERSE=prediction` in the shell). Contract
prices before the quote tape saw them come from the venues' own minute history when
`V2_BENCH_PREDICTION_HISTORY=1` (`quotes/prediction-history.ts`); a market is never priced at
or after it closed. Search stays off in the bench, so a hold can mean "unresearchable".

## Reading the results

- Compare a desk with other arms on a common window, not on each arm's own start date.
- A paper desk without `V2_KALSHI_FEES=1` overstates its result.
- A few weeks and a few dozen contracts cannot separate an edge from luck. `V2_SHADOW_KALSHI`
  shows what real books would have filled; read those rows before drawing conclusions.
