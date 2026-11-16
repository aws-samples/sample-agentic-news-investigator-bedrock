# Live trading on Kalshi (real money, off by default)

Everything else in this repository is paper trading. This document covers the one path that is
not: `v2/src/live/`, which can route a fast-desk arm's orders to Kalshi. It is **off unless you
set `V2_LIVE`**, no shipped template sets it, and nothing here is a recommendation to turn it on.

> **Read this first**
>
> - **You can lose all of the money in the account.** This is sample code. It has had no
>   production hardening, no independent audit and no track record that supports trading it.
>   A paper result over a few weeks does not show an edge.
> - **Not investment advice.** Nothing in this repository is a recommendation to trade.
> - **You need the venue's permission.** Kalshi's Developer Agreement limits API use to a
>   member's own trading on the exchange, and its Data Terms prohibit use of its data with AI/ML
>   systems ([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). An LLM deciding trades from
>   Kalshi's data is exactly that. Do not enable this without Kalshi's written permission for
>   this use, and confirm that permission covers automated order placement, not only research.
> - **Check your own obligations**: your employer's rules on personal trading and trading
>   tools, your jurisdiction's rules on event contracts, and tax reporting.
> - **Run it in an account you pay for.** The live arm should have its own AWS account, its own
>   model spend and its own copy of the stack. Do not attach real money to a shared, sponsored
>   or employer-funded deployment.

## What exists

| Module | Role |
|---|---|
| `live/kalshi-core.ts` | Pure: symbols, the taker fee, order-book parsing and walking, order mapping (one book per market; NO is the YES book at `1 − price`; immediate-or-cancel; exits `reduce_only`; limits rounded so they never loosen), deterministic `client_order_id`. |
| `live/kalshi-client.ts` | Signed REST client (Ed25519 or RSA-PSS over `timestamp + METHOD + path`). Demo and production hosts. |
| `live/limits.ts` | Pure hard limits in real dollars. Exits are never blocked. |
| `live/broker.ts` | `executeLive`: kill switch (fails closed) → Kalshi contracts only → order book → limits from the exchange's own balance and positions → one immediate-or-cancel order → the real fill and fee written to the arm's ledger. Refuses to buy one side of a market while the other is held. `reconcile` diffs ledger and exchange. |
| `live/route.ts` | `execute()`: with `V2_LIVE=off` it is exactly the paper `executeDecision`. Otherwise it calls the broker. The worker runs `reconcilePass` every 15 minutes when live. |
| `live/shadow.ts` | Observer for a paper arm: what a real order would have got (`V2_SHADOW_KALSHI=1`). |
| `live/cli.ts` | `status`, `book TICKER`, and a demo-only `test-order`. |

What does **not** exist: Polymarket or any second venue, moving cash between venues, deposits
or withdrawals, tax records, alerting, and any automatic repair when the ledger and the
exchange disagree.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `V2_LIVE` | `off` | `demo` or `prod` routes every buy and sell to Kalshi. Any other venue is refused. |
| `V2_ENABLE_SOURCES` | none | Must include `kalshi`, or the live arm halts before any call. |
| `V2_KALSHI_KEY_ID` | none | API key id. |
| `V2_KALSHI_KEY_PATH` / `V2_KALSHI_KEY_PEM` | none | The private key: a file path, or the PEM itself. |
| `V2_LIVE_KILL_SWITCH_PARAM` | `/<prefix>/<arm>/live-kill-switch` | SSM parameter. Trading proceeds only while it reads exactly `false`. Missing, unreadable or anything else halts buys **and** sells. |
| `V2_LIVE_MAX_ORDER_USD` | `50` | Largest single order. |
| `V2_LIVE_MAX_POSITION_USD` | `100` | Largest cost basis in one contract. |
| `V2_LIVE_MAX_DEPLOYED_USD` | `400` | Largest total cost basis. |
| `V2_LIVE_DAILY_LOSS_STOP_USD` | `50` | No new buys once equity at cost is this far below the day's start. |
| `V2_LIVE_MIN_PRICE` / `V2_LIVE_MAX_PRICE` | `0.05` / `0.95` | Buy only inside this price band. |
| `V2_LIVE_SLIPPAGE` | `0.02` | How far past the top of book an order without its own limit may reach, dollars per contract. |
| `V2_SIZING_MULTIPLIER` | `1` | Scales the equity the agent sizes against (below). |

The limit defaults are sized for a first account of about $500. They are deliberately small.

## Setup

Do the steps in order. Each one ends with something you can check.

### 1. Shadow a paper arm (no money, no key)

Run a paper fast desk ([PREDICTION_DESK.md](PREDICTION_DESK.md)) with `V2_KALSHI_FEES=1` and
`V2_SHADOW_KALSHI=1`. Each paper Kalshi trade writes a `v2-shadow` audit row: the real book
walk, the fee, and the gap to the paper fill. Read them for at least four weeks. You are
looking for the desk's return re-marked with real fills and fees, net of its model spend.

### 2. Your own infrastructure

Deploy a separate copy of the stack in an AWS account you own, with one agent arm for live
trading (for example `live` in `arms.json`) and nothing else riding on it:

```bash
cd infra && npx cdk deploy -c contactEmail=you@example.com -c enableSources=kalshi
```

The stack creates the arm's table, queue, kill switch and budget. The live kill switch and
its read permission are **not** created by the stack; add them yourself:

```bash
aws ssm put-parameter --name /fin/live/live-kill-switch --type String --value true
# then allow the worker's identity to read it:
aws iam put-role-policy --role-name <worker-role> --policy-name live-kill-switch-read \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ssm:GetParameter","Resource":"arn:aws:ssm:<region>:<account>:parameter/fin/live/live-kill-switch"}]}'
```

It starts as `true`, which means halted.

### 3. Demo plumbing (play money)

Create an account and an API key on Kalshi's demo exchange. Store the private key where only
the worker's user can read it (mode `0400`), never in the repository, an image or a shell
history.

```bash
cd v2 && npm run compile
export V2_KALSHI_KEY_ID=<demo key id> V2_KALSHI_KEY_PATH=/etc/fin/kalshi-demo.pem
node dist/live/cli.js status --env demo
node dist/live/cli.js test-order <TICKER>:YES buy 1 0.50 --env demo
```

Place one test order per case (buy YES, buy NO, sell each) and compare what the CLI reads back
with the demo web page. This confirms the one open assumption in the order mapping: that
`average_fill_price` is quoted on the YES book, so a NO fill is `1 −` it. If it is not, fix
`fromCreateOrderResponse` in `kalshi-core.ts` before going further.

Then run the worker itself against demo for several days with `V2_LIVE=demo`.

### 4. Seed the live arm with the real balance

The ledger must start at what the account holds. Fund Kalshi, read the balance, seed exactly
that:

```bash
node dist/live/cli.js status --env prod
npm run seed -- --arm live --cash <balance> --apply
```

### 5. The live arm's environment

Start from the arm's block in the stack's `ArmsEnv` output, add the fast-desk block from
[PREDICTION_DESK.md](PREDICTION_DESK.md), then:

```bash
V2_DRY_RUN=false
V2_ENABLE_SOURCES=kalshi
V2_LIVE=prod
V2_KALSHI_KEY_ID=<prod key id>
V2_KALSHI_KEY_PATH=/etc/fin/kalshi-prod.pem
V2_LIVE_KILL_SWITCH_PARAM=/fin/live/live-kill-switch
V2_LIVE_MAX_ORDER_USD=50
V2_LIVE_MAX_POSITION_USD=100
V2_LIVE_MAX_DEPLOYED_USD=400
V2_LIVE_DAILY_LOSS_STOP_USD=50
```

Polymarket stays out of `V2_ENABLE_SOURCES`: the live broker refuses every non-Kalshi order,
so a desk that can see Polymarket would spend investigations on trades it cannot place.

### 6. Go live

Set the kill switch to `false`, start the worker, and watch the first day by hand:

```bash
aws ssm put-parameter --name /fin/live/live-kill-switch --type String --value false --overwrite
```

## Sizing: limits and the multiplier

Two separate controls decide how large a live position can be.

**The live limits** (`V2_LIVE_MAX_*`) are in real dollars and are checked against the
exchange's own balance and positions on every order. They are the backstop. Raise them
deliberately, in steps, as the account earns it.

**The sizing multiplier** (`V2_SIZING_MULTIPLIER`, default `1`) changes what the agent asks
for. The agent sizes each position as a share of equity. With a multiplier above 1 the equity
shown in its mandate, and used by the per-decision exposure cap, is the account's equity times
the multiplier; the book context adds a line saying so and stating the cash on hand. Positions,
deployed dollars and cash are always shown as they are.

Why it exists: a fast desk on a small account leaves most of its cash idle, because quarter-
Kelly stakes on a handful of short-lived contracts rarely add up to much of the book. The
multiplier makes the same decisions larger.

What it costs: it is leverage on the agent's own sizing rule, and every risk scales with it.

| Multiplier | Effective Kelly fraction | A position the agent sizes at 3% of equity | Fees and drawdowns |
|---|---|---|---|
| 1 | quarter | 3% of the account | as measured on paper |
| 2 | half | 6% of the account | 2× |
| 5 | 1.25× full Kelly | 15% of the account | 5× |

Above 4 the desk bets more than full Kelly, which lowers long-run growth even when the
agent's probabilities are right, and they are estimates. At 5, two total losses on the
larger positions can take a fifth of the account. The mandate's per-contract cap and the
per-decision exposure cap are shares of the *scaled* equity, so they scale too; only the live
limits and the cash balance stay in real dollars. When cash runs short the live broker cuts an
order down to what the account can fund, and refuses it if nothing is left.

An illustrative block for a $10,000 account at 5×. These numbers are an example of how the
pieces fit, not a recommendation:

```bash
V2_SIZING_MULTIPLIER=5
V2_MAX_NEW_EXPOSURE_PCT=6           # 6% of $50,000 sizing equity = $3,000 per decision
V2_LIVE_MAX_ORDER_USD=1500
V2_LIVE_MAX_POSITION_USD=3000       # 30% of the account in one contract
V2_LIVE_MAX_DEPLOYED_USD=8000
V2_LIVE_DAILY_LOSS_STOP_USD=750
```

Model spend does not shrink with the account. A desk that costs several dollars a day to run
needs a real edge of that size, after fees, before it earns anything.

## Go / no-go

**Go** only if, after four or more weeks of shadow rows: the desk's return re-marked with
shadow fills and fees is positive after its model spend, the median shadow fill ratio is at
least 90% at the sizes you intend to trade, and the demo run reconciled cleanly.

**Stop** if the daily loss stop fires twice in a week, if any reconcile difference is
unexplained, or if the shadow-adjusted return turns negative over a rolling two weeks.

## Runbook

- **Halt everything**: set the live kill switch to anything but `false`. The broker re-reads
  it on every order. Exits are halted too; to exit while halted, sell on Kalshi's own site.
- **Check the account**: `node dist/live/cli.js status --env prod`.
- **Drift**: `v2-live-reconcile` audit rows (`NEWS#live-reconcile-<date>`) and `[live]
  reconcile` in the worker log. Nothing is repaired automatically: you decide whether the
  ledger or the exchange is wrong.
- **Rotate the key** on any suspicion that it leaked, and after any change of host.

## Known limits

- The `average_fill_price` convention for NO orders is assumed, and confirmed only by step 3.
- Settlement: Kalshi pays out settled contracts itself. The ledger's settlement bookkeeping
  (`watch.ts`) approximates it and the reconcile pass catches differences.
- The daily loss stop uses equity at cost (cash plus cost basis). It reacts to realized losses
  and fees, not to open positions moving against you.
- The investigator's system prompt still describes a paper system. The agent is not told the
  money is real; its instructions are the ones the paper desk was measured with.
- An order is immediate-or-cancel. What does not fill at once is not worked.
- One venue. A desk limited to Kalshi makes different trades from one that also sees
  Polymarket, so a two-venue paper result does not carry over.
- Paper arms have no risk gate by design. The live limits above are the only gate here, and
  they bound order size, position size, total deployment and a day's realized loss. They do
  not judge the trade.
