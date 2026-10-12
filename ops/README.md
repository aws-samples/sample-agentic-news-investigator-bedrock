# Operating the fin workers

Three long-running processes make up an arm's runtime, all from `v2/dist/` after
`npm run compile`:

| Process | Entry point | Cadence |
|---|---|---|
| Worker, one per arm | `node dist/worker.js` | always on; long-polls the arm's SQS queue, runs the 5-min watch, 15-min score and (world-model arm) hourly curiosity passes |
| Daily letter, one per deployment | `node dist/daily-report.js` | once a day at 08:00 local |
| Dashboard (optional, read-only) | `node dist/dashboard.js` | on demand; loopback only, port 4310 |

This directory holds supervisor templates for three hosts — macOS (`launchd/`),
Linux (`systemd/`) and containers (`docker/`) — and this guide. Nothing here
publishes events or touches a table; the templates only start the processes the
stack already expects.

Two rules that apply everywhere:

1. **Run the compiled JavaScript**, never `tsx`. `tsx` hangs under launchd, and a
   supervisor that runs `dist/` keeps running the *old* code until you
   `npm run compile` and restart it.
2. **The code default is dry-run** (`V2_DRY_RUN` unset = `true`: decide and
   audit, no fills). Set `V2_DRY_RUN=false` only when you mean to fill the paper
   book. Every other knob and its default is documented in `v2/src/config.ts`;
   read it before adding a variable.

## Prerequisites

- Node >= 20. `cd v2 && npm ci && npm run build && npm test && npm run compile`.
- The stack's outputs for each arm: SQS queue URL, DynamoDB table, SSM kill switch
  and daily budget parameters (`/fin/<arm>/kill-switch`,
  `/fin/<arm>/daily-budget-usd`), plus the shared quote tape table and transcript
  bucket.
- An identifying contact for SEC EDGAR requests (`V2_EDGAR_CONTACT`). The SEC's
  fair-access policy requires it on every request `read_source` makes.
- A seeded book (`npm run seed -- --arm <key> --cash 100000 --apply` in `v2/`) — once, per arm.
- An identity holding the stack's `WorkerPolicy` (see *Credentials*).

## Environment a worker needs

| Variable | Purpose |
|---|---|
| `V2_ARM` | arm key (`v2`, `v3`, …); prefixes logs and transcripts |
| `V2_WORLD_MODEL` | `1` for the world-model arm, `0`/unset for the control |
| `V2_QUEUE_URL` | the arm's news queue |
| `V2_TABLE` | the arm's trading table |
| `V2_KILL_SWITCH_PARAM`, `V2_DAILY_BUDGET_PARAM` | the arm's SSM parameters |
| `V2_TAPE_TABLE` | quote tape, shared by every arm |
| `V2_TRANSCRIPT_BUCKET` | S3 bucket for full agent transcripts |
| `V2_EDGAR_CONTACT` | SEC User-Agent contact |
| `V2_DRY_RUN` | `true` (default) or `false` |
| `V2_MAX_INVESTIGATIONS_PER_DAY` | per-day investigation cap (code default 20) |
| `V2_GUARDRAIL_ID`, `V2_GUARDRAIL_VERSION` | optional Bedrock guardrail (stack outputs `GuardrailId`, `GuardrailVersion`); both or neither, see *Bedrock guardrail* |
| `AWS_REGION`, `AWS_PROFILE`, `AWS_SDK_LOAD_CONFIG=1` | see *Credentials* |
| `PATH` | must include the node binary and the directory of any credential helper |

## Credentials

The workers use the AWS SDK's default provider chain and nothing else, so any of
these work: environment variables (`AWS_ACCESS_KEY_ID` …), a profile in
`~/.aws/credentials`, a profile in `~/.aws/config` backed by `credential_process`
or an `sso-session`, an EC2 instance role, an ECS task role. Set
`AWS_SDK_LOAD_CONFIG=1` (the templates do) so the SDK reads `~/.aws/config`.

The private deployment runs a profile backed by a **credential process** — a
helper program the SDK calls for short-lived credentials. Two consequences are
worth carrying over to any similar setup:

- The helper must be on the worker's `PATH`. Supervisors start jobs with a
  minimal `PATH`; the launchd template has a `${CREDENTIAL_PROCESS_DIR}` slot for
  exactly this.
- The helper's own upstream session can expire, and then **every** call fails —
  Bedrock, DynamoDB, SQS alike — and the worker goes quiet rather than loud. The
  private deployment was dark for 7.5 hours one night for this reason. A role
  (EC2, ECS) has no such session; prefer one for unattended hosts.

**Attach the stack's worker policy and nothing broader.** The stack creates a
customer-managed policy, `WorkerPolicy` (stack output `WorkerPolicyArn`), with
exactly what the worker, the letter, the dashboard and the replay bench need,
on the resources the stack created:

| Service | What `WorkerPolicy` grants |
|---|---|
| Bedrock | `InvokeModel`, `InvokeModelWithResponseStream` on Anthropic models and inference profiles and on Nova 2 Lite (web search); `InvokeTool` on the `amazon.nova_grounding` system tool |
| DynamoDB | read/write on every agent arm's table and the quote tape (+ GSIs); read on the pipeline arm's table |
| SQS | consume on each agent arm's queue and the replay queue; purge on the replay queue |
| S3 | read/write on the transcript and archived-bodies bucket |
| SSM | read on each agent arm's kill switch and daily budget parameters |
| EventBridge | enable/disable/describe the replay rule; start/describe/cancel a replay from the bus archive |

It grants no IAM actions and no write on the SSM parameters, so a stolen worker
credential can neither widen its own access nor turn off a kill switch. Attach it
to whatever identity runs the processes:

```bash
POLICY_ARN=$(aws cloudformation describe-stacks --stack-name FinStack \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerPolicyArn'].OutputValue" --output text)
aws iam attach-role-policy --role-name <worker-task-or-instance-role> --policy-arn "$POLICY_ARN"
# or: a permission set / IAM user for a profile on a workstation
```

Running the worker as an administrator works, but turns a compromised worker host
into a compromised account. That is the main credential risk in
`docs/THREAT_MODEL.md` (T06). Changing a kill switch or budget (`aws ssm
put-parameter`) is an operator action, done with the operator's own credentials,
not the worker's.

## macOS: launchd

Templates: `launchd/com.fin.worker.plist.example` (one per arm) and
`launchd/com.fin.daily-report.plist.example`. launchd does not expand
`${VAR}`, so render first:

```bash
export ARM=v2 WORLD_MODEL=0 FIN_HOME=/path/to/fin \
       NODE_BIN="$(dirname "$(command -v node)")" LOG_DIR="$HOME/Library/Logs" \
       CREDENTIAL_PROCESS_DIR=/usr/local/bin AWS_PROFILE=fin AWS_REGION=us-east-1 \
       QUEUE_URL=… TABLE=fin-v2-trading TAPE_TABLE=fin-quote-tape TRANSCRIPT_BUCKET=… \
       EDGAR_CONTACT=you@example.org DRY_RUN=true MAX_INVESTIGATIONS_PER_DAY=200
envsubst < ops/launchd/com.fin.worker.plist.example > ~/Library/LaunchAgents/com.fin.$ARM-worker.plist
plutil -lint ~/Library/LaunchAgents/com.fin.$ARM-worker.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.fin.$ARM-worker.plist
```

Repeat with `ARM=v3 WORLD_MODEL=1` and the v3 queue and table. Then the letter:

```bash
envsubst < ops/launchd/com.fin.daily-report.plist.example > ~/Library/LaunchAgents/com.fin.daily-report.plist
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.fin.daily-report.plist
```

Day to day:

| You changed… | Do |
|---|---|
| code (`npm run compile`) | `launchctl kickstart -k gui/$UID/com.fin.<arm>-worker` |
| anything in `EnvironmentVariables` | `launchctl bootout gui/$UID/com.fin.<arm>-worker`, then `bootstrap` again — launchd caches the plist at bootstrap; `kickstart` re-runs the **old** environment |
| nothing, want the letter now | `launchctl kickstart gui/$UID/com.fin.daily-report` |

`KeepAlive/SuccessfulExit=false` relaunches on crashes, not on a clean exit;
`ThrottleInterval` 30 keeps a crash loop to one attempt per 30 s.
`StartCalendarInterval` fires at the next 08:00 the machine is awake — a Mac
asleep at 08:00 runs the letter once on wake; a Mac that is off runs nothing.

Logs: `${LOG_DIR}/fin-<arm>-worker.log`, `${LOG_DIR}/fin-daily-report.log`
(stdout and stderr together). `launchctl print gui/$UID/com.fin.<arm>-worker`
shows state, PID and last exit status.

## Linux: systemd

Templates: `systemd/fin-worker@.service` (instance name = arm key),
`systemd/fin-daily-report.service` + `.timer`. Assumed layout: the repository at
`/opt/fin` with `v2/dist/` compiled, a system user `fin`, environment files under
`/etc/fin/`.

```bash
sudo useradd --system --home /var/lib/fin --create-home --shell /usr/sbin/nologin fin
sudo install -d -o fin -g fin /opt/fin/v2/reports
sudo install -d -m 0750 -g fin /etc/fin
sudo install -m 0640 -g fin v2.env /etc/fin/v2.env      # from the block below
sudo install -m 0644 ops/systemd/fin-worker@.service ops/systemd/fin-daily-report.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fin-worker@v2 fin-worker@v3 fin-daily-report.timer
```

`/etc/fin/<arm>.env.example` — one file per arm, no credentials in it:

```ini
# /etc/fin/v2.env — read by fin-worker@v2 (and by the daily letter)
V2_ARM=v2
V2_WORLD_MODEL=0
V2_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/<account-id>/fin-v2-news
V2_TABLE=fin-v2-trading
V2_KILL_SWITCH_PARAM=/fin/v2/kill-switch
V2_DAILY_BUDGET_PARAM=/fin/v2/daily-budget-usd
V2_TAPE_TABLE=fin-quote-tape
V2_TRANSCRIPT_BUCKET=<transcript-bucket-name>
V2_EDGAR_CONTACT=you@example.org
V2_DRY_RUN=true
V2_MAX_INVESTIGATIONS_PER_DAY=200
AWS_REGION=us-east-1
# Leave AWS_PROFILE unset on EC2 to use the instance role; otherwise name a
# profile in /var/lib/fin/.aws/config.
#AWS_PROFILE=fin
# Only needed when the profile uses a credential_process outside the default PATH.
#PATH=/usr/local/bin:/usr/bin:/bin
```

For `v3.env` change `V2_ARM=v3`, `V2_WORLD_MODEL=1`, the queue, the table and the
two SSM parameters. Optional `/etc/fin/letter.env` adds letter-only settings
(`V3_TABLE`, `V2_LETTER_EFFORT`, `V2_PRINT_CMD`).

Day to day: `systemctl restart fin-worker@v2 fin-worker@v3` after `npm run
compile` or after editing an env file; `systemctl start fin-daily-report` for a
letter now; `systemctl list-timers fin-daily-report.timer` for the next run.
`Restart=on-failure` with `RestartSec=30` mirrors the launchd behaviour;
`StartLimitBurst=5` in 300 s stops a credential outage from filling the journal.
`Persistent=true` on the timer runs a missed 08:00 as soon as the host is back.

Logs: the journal. `journalctl -u fin-worker@v2 -f`,
`journalctl -u fin-daily-report -n 200`. There are no log files; the dashboard's
log probe needs `V2_SUPERVISOR=systemd` to know that (below).

## Containers: Docker Compose

`docker/Dockerfile` builds one image (multi-stage: `npm ci && npm run compile` on
`public.ecr.aws/docker/library/node:24-trixie-slim`; runtime on
`public.ecr.aws/amazonlinux/amazonlinux:2023-minimal` with the distribution's
`nodejs24`, as an unprivileged `nonroot` user (uid 65532), entrypoint `node`,
`CMD ["dist/worker.js"]`. Both bases come from ECR Public. There is a shell but
no npm, find or which; `docker exec -it <container> sh` works for a look around).
`docker/compose.yml` runs it as one service per arm (`v2`,
`v3`), plus two opt-in profiles: `dashboard` (port 4310 bound to `127.0.0.1`
only) and `letter` (one-shot).

```bash
cp ops/docker/.env.example ops/docker/.env          # stack outputs; never commit .env
docker compose -f ops/docker/compose.yml up -d --build          # v2 + v3 workers
docker compose -f ops/docker/compose.yml logs -f v3
docker compose -f ops/docker/compose.yml --profile dashboard up -d dashboard
docker compose -f ops/docker/compose.yml --profile letter run --rm letter
```

Credentials reach the containers three ways, none of them through a file in this
repository: `FIN_AWS_DIR` (default `~/.aws`) mounted **read-only** at
`/home/nonroot/.aws` with `AWS_PROFILE` naming a profile (a `credential_process`
would have to exist inside the container, so use a static profile, an
`sso-session` or a role; the container runs as uid 65532, so on a Linux host
the directory must be readable by that uid, e.g. `setfacl -R -m u:65532:rX`
on a copy holding only that profile - Docker Desktop does not enforce host
ownership); `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` exported in the shell that runs compose (passed through);
or, on ECS/EC2, the task or instance role.

Things to know:

- `npm ci` runs inside the image on purpose: the Agent SDK pulls a per-platform
  native package, so a macOS `node_modules` does not run on Linux.
- The image has no pandoc or weasyprint. The letter's markdown is written to the
  `fin-reports` volume; the `.docx`/`.pdf` steps log their failure and the run
  succeeds. Extend the image if you want them.
- Compose has no scheduler: run the `letter` profile from host cron or a
  systemd timer at 08:00.
- The image has not been built as part of this package (no registry pull was
  allowed); `docker compose config` validates. Build it once and watch one
  investigation end to end before trusting it unattended.

## Dashboard on a non-macOS host

The dashboard's operations card probes the supervisor, the printer and the
worker logs. Those probes were written for launchd, CUPS and
`~/Library/Logs`; the dashboard runtime package makes them degrade to "not
available" elsewhere and introduces two variables. The names are fixed; their
defaults and the exact placeholder syntax are documented where they are read,
in `v2/src/dashboard.ts`.

| Variable | Meaning |
|---|---|
| `V2_SUPERVISOR` | `launchd`, `systemd` or `none` — which supervisor the dashboard should ask about the worker processes. Set `systemd` on a Linux host, `none` in a container (the compose file does). |
| `V2_WORKER_LOG_PATTERN` | Where a worker's log lives, as a path pattern with an arm placeholder, so the log-freshness probe finds `fin-<arm>-worker.log` wherever `${LOG_DIR}` was pointed. Under systemd the log is the journal and this is not needed. |

Other dashboard knobs: `V2_DASHBOARD_PORT` (4310), `V2_DASHBOARD_REFRESH_SECS`
(90), `V3_TABLE` for the second arm's book. The server binds loopback only; put
it behind SSH port-forwarding or a reverse proxy with authentication if you need
it off-host.

## Printing the letter

Rendering (`.md` → `.docx`/`.pdf`) always happens when pandoc and weasyprint
are on `PATH`; **printing is opt-in** with `V2_PRINT=1`, set only in the
scheduled job so hand-runs never reach the paper tray.

| Variable | Effect |
|---|---|
| `V2_PRINT=1` | print the narrative PDF after rendering |
| `V2_PRINTER` | CUPS queue name (macOS); the CUPS default when unset |
| `V2_PRINT_CMD` | any platform: run this command with the PDF path as its only argument instead of CUPS `lp` — e.g. a script that runs `lpr` or mails the PDF |
| `V2_WEASYPRINT` | path to the weasyprint binary when it is not in a standard place |

Without `V2_PRINT_CMD`, a non-macOS host logs `printing not available on this
platform` and keeps the PDF (`v2/src/print.ts`).

## Bedrock guardrail

The stack always creates one Bedrock guardrail and a published version of it
(`infra/lib/guardrail.ts`). Stack outputs `GuardrailId` and `GuardrailVersion`
name them. The alarm `Interventions` emails the alerts topic in any hour with
at least one block. Each arm has its own switch:

- **v1** uses it by default. Deploy with `-c guardrail=off` to keep the Lambdas
  unguarded (they then get no `GUARDRAIL_ID` / `GUARDRAIL_VERSION`). Either way
  the guardrail exists and the roles hold `bedrock:ApplyGuardrail` on it.
- **v2 / v3** use it only when a worker has both `V2_GUARDRAIL_ID` and
  `V2_GUARDRAIL_VERSION`. With one but not the other the worker refuses to start.

The guardrail changes what the agent sees and what it costs, so a guarded arm
is a different experiment. Measure it on the bench before switching it on.

1. Bench the `guardrail` variant against `live` on the same events. Only the
   variant runs behind the guardrail; triage and the `live` variant stay
   unguarded, so leave `V2_GUARDRAIL_ID` unset in the bench shell:

   ```bash
   cd v2
   npm run replay -- --name bench-guardrail --max 20 --budget-usd 15 \
     --days 7 --end-days-ago 7 --variants live,guardrail \
     --guardrail-id <GuardrailId> --guardrail-version <GuardrailVersion>
   ```

   Compare the two `BENCHSUM` rows: hold rates, fills, outcome scores and cost.
   Rows the guardrail blocked carry `guardrail_intervened`. A block on ordinary
   news is a false positive. Count those before going live.
2. Switch an agent arm on. Add both variables to the worker's environment (the
   plist `EnvironmentVariables`, the systemd env file or the compose env). On
   macOS that means `launchctl bootout` then `bootstrap`, not `kickstart`. Watch
   the log for `[guardrail]` lines. Triage blocks show in the letter's news flow
   as not material with a `guardrail:` note. Investigator blocks are holds with
   `guardrail_intervened` on the `v2-decision` row.
3. Switch v1 on or off with `cdk deploy -c guardrail=on|off` (plus your usual
   context). Its blocks are triage rows with `guardrail_intervened` (not
   material) and analysis `parse_error` rows with `guardrail_intervened` (no
   trade).

To change the policy, edit `infra/lib/guardrail.ts`. Then change the
`CfnGuardrailVersion` description too, because a new version is published only
when the version resource changes. Deploy, then point the workers at the new
`GuardrailVersion` output.

Tool-output screening (`read_source`, `web_search`) **fails open**: a timeout
(`V2_GUARDRAIL_SCREEN_TIMEOUT_MS`, 8000) or an error passes the text through
unscreened and logs `[guardrail] … screen failed open`. Everything else fails
closed: a block is a hold, a not-material triage or a rejected link. Cost:
[`docs/COST.md`](../docs/COST.md#guardrail-costs).

## Where the logs are

| Host | Worker | Letter |
|---|---|---|
| launchd | `${LOG_DIR}/fin-<arm>-worker.log` | `${LOG_DIR}/fin-daily-report.log` |
| systemd | `journalctl -u fin-worker@<arm>` | `journalctl -u fin-daily-report` |
| compose | `docker compose logs -f <arm>` (json-file, 5 × 50 MB) | `docker compose --profile letter run --rm letter` prints to the terminal |

Every worker line is prefixed by its module — `[worker]`, `[pipeline]`,
`[watch]`, `[tape]`, `[pending]`, `[investigate]`, `[curiosity]` — so a
`grep '^\[pipeline\]'` is the decision stream. The worker logs each message it
handles and each periodic pass that did work; a quiet queue is a quiet log, but
a log that has not moved while the queue holds messages means the process is
stuck or the credentials are.

The pipeline arm's Lambdas log JSON lines to CloudWatch Logs
(`aws logs tail /aws/lambda/<function> --follow`) at the level the deploy set:
`-c logLevel=` on `cdk deploy` (`error|warn|info|debug|trace`, default `warn`,
which keeps errors, dropped orders, risk-gate limit refusals and kill-switch
trips; low-confidence and cooldown refusals and per-event progress need
`info`). Each function reads it from `RUST_LOG`, which also accepts per-crate
directives (`info,aws_smithy_runtime=warn`) when set on a function by hand; an
unrecognised value falls back to `warn`. Their log groups keep events for
`-c logRetentionDays=` days (default 30).

## Troubleshooting

- **Worker silent** (log not moving, queue not draining): the credential chain
  first. `aws sts get-caller-identity` with the same profile and `PATH` the
  supervisor uses; a `credential_process` helper whose upstream session expired
  fails every SDK call and the worker waits rather than crashes. Then
  `launchctl print` / `systemctl status` for the last exit status, and the kill
  switch (`scripts/kill-switch-<arm>.sh status`).
- **Letter did not appear at 08:00**: the host was asleep or off (launchd runs
  a missed job on wake; a systemd `Persistent` timer runs it at next boot), or
  it had no network — the narrative streams from Bedrock and a run whose
  narrative failed does not advance the anchor, so the next successful run
  covers the gap (up to 72 h). Check the letter log for `stop_reason` and
  retries.
- **Queue depth growing** (`ApproximateNumberOfMessagesVisible` climbing on the
  arm queue): the worker for that arm is down or stuck. Messages older than
  `V2_MAX_NEWS_AGE_HOURS` (6) are dropped on receipt, so a restart drains the
  backlog cheaply; nothing is investigated late.
- **Investigations all end as zero-confidence holds at $0.00**: the Agent SDK
  could not start its runtime or expose the `fin` tools — a bundled CLI too old
  for the model, a tool schema the SDK cannot convert, or (in a container) an
  unwritable `$TMPDIR` or `~/.claude`. `npm test` runs `test/tools.test.ts`,
  which lists the tool server exactly as the runtime does.
- **`plutil -lint` fails** on a rendered plist: an unset `${VAR}` rendered as
  an empty string is still valid XML, so look for a literal `&` in a value
  (queue URLs never contain one, but a contact string might) and escape it as
  `&amp;`.
