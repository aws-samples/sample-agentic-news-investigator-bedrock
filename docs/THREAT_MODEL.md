# fin — threat model

*Canonical artifact:* `docs/threat-model.tc.json` (Threat Composer format, schema 1; import it at
https://awslabs.github.io/threat-composer or open it with the AWS Toolkit VS Code extension). This document is
rendered from it by `scripts/render-threat-model.mjs` and uses the same numbering (T = threat,
M = mitigation, AS = assumption). Change the JSON, then re-render; only section 4 is written by hand here.

*Method:* the AWS four-question threat model (what are we working on, what can go wrong, what are we
going to do about it, did we do a good job), threats written in the AWS threat grammar, STRIDE
classification, priorities High/Medium/Low. It is kept alongside the architecture description
(`docs/ARCHITECTURE.md`) and the scan policy (`.ash/.ash.yaml`), and reviewed before each release.

*Status:* 18 threats, 27 mitigations, 8 assumptions.
Threats: 16 resolved, 2 identified with residual risk or planned mitigations.
Mitigations: 27 implemented, 0 in progress, 0 planned.
Open items are listed in section 4.

---

## 1. What are we working on

`fin` is a research sample (aws-samples, not production-ready) that turns public financial news into **simulated** trades. Three arms share one EventBridge bus:

- **v1 (control):** serverless Rust pipeline — pollers → Haiku triage → Sonnet analysis → deterministic risk gate → paper execution, all Lambda, ledger in DynamoDB `fin-trading`.
- **v2 (experiment):** a TypeScript Claude Agent SDK investigator (Fable 5.1 on Bedrock) running on a worker host or container, fed by SQS, with an in-process MCP tool server (quotes, primary sources, web grounding, portfolio, `submit_decision`). Deliberately **no risk gate**; a paper broker's bookkeeping is the only hard limit.
- **v3:** v2's code plus a gated shared world model and an hourly curiosity loop.

**No real money exists anywhere.** Fills are simulated against live quotes; there is no brokerage integration. The security goals are therefore: protect the AWS account and credentials, bound LLM spend, keep the experiment's records trustworthy, and keep the worker host and the experiment's data private.

Method: AWS four-question threat model, threats in threat grammar, STRIDE classification, Threat Composer data format. Companion artifacts: `.ash/.ash.yaml` (scanner policy, all scanners PASSED 2026-09-19), Ferret scan (no secrets), `docs/THREAT_MODEL.md` (narrative).

### Components and trust boundaries
**B1 Internet → ingestion (Lambda, Rust).** Five pollers on EventBridge schedules fetch public feeds (SEC EDGAR Atom, GlobeNewswire, CoinDesk/Cointelegraph, USGS, NHC/GDACS, Fed, ECB). They write `NewsItem` events to the bus `fin-events`, article bodies to S3 `NewsBodies`, and dedupe rows to DynamoDB. Feed content is **untrusted**.

**B2 Bus → v1 stages (Lambda).** triage-agent → analysis-agent (Bedrock Converse, small tool loop) → risk-gate (pure Rust, reads SSM kill switch) → exec-engine (transactional ledger). Each function has its own IAM role with per-resource grants.

**B3 Bus → SQS → v2/v3 worker (any host or container: launchd, systemd, Docker Compose, ECS or EC2).** `fin-v2-news` / `fin-v3-news` queues with DLQs. The worker claims each item (idempotent), enriches 8-Ks by accession, triages with Haiku, checks the SSM daily budget, then runs one bounded Agent SDK `query()`: built-in tools disabled, only the in-process `fin` MCP server. Decisions are executed by a paper broker into `fin-v2-trading` / `fin-v3-trading`; every price observed is written to `fin-quote-tape`; full transcripts go to S3.

**B4 Agent → external data.** Keyless quote APIs (Yahoo, Kraken, Coinbase, CriptoYa, Polymarket, Kalshi); Amazon Nova web grounding via Bedrock (AWS credentials only); `read_source` fetches SEC filings by accession, archived bodies from S3, or the event's own URL (live mode only).

**B5 Observers (read-only).** Dashboard (loopback :4310), daily letter (Bedrock direct client → PDF → CUPS), A/B report. Alerts: CloudWatch alarms → SNS `fin-alerts` → operator email.

**B6 Replay bench.** EventBridge archive → normally-disabled replay rule → `fin-v2-replay` queue → simulated book with as-of quotes. Never touches live tables; refuses live URLs.

### Credentials
Lambdas: per-function IAM roles. Workers, letter and dashboard: the AWS SDK default provider chain (a profile mounted read-only, environment variables, or an ECS task / EC2 instance role); nothing in the repo, compose file or `.env` holds a credential. The stack exports `WorkerPolicyArn`, a least-privilege managed policy holding exactly what those processes need — the two queues, the trading tables and the tape, the transcript bucket, read-only SSM parameters, the bench's archive and replay, and Bedrock invoke on the named models and Nova grounding — with no IAM actions and no SSM writes. Adopters attach it to the worker identity and nothing broader (`ops/README.md`).

### Data flows and classification
1. Public feed → poller → `NewsItem` (headline, summary, url, tickers) on the bus; body → S3 (30-day expiry, versioned). Classification: public, untrusted.
2. `NewsItem` → triage (Haiku) → investigation (Fable) → `submit_decision` → paper fill → DynamoDB rows (`ORDER#`, `POSITION#`, `PORTFOLIO/SNAPSHOT`, `NEWS#<id>` audit stages, `THESIS#`, `SCOREQ`). Classification: experiment record; integrity matters, no real money, no PII.
3. Investigation → Bedrock (model calls, Nova grounding) → cost folded into the SSM-bounded daily spend. Classification: money (bounded).
4. Investigation transcript (prompts, tool results incl. third-party content, reasoning) → S3 `NewsBodies` bucket. Classification: low confidentiality; may contain injected content; no secrets.
5. Quotes → `fin-quote-tape` (90-day TTL, RETAIN). Classification: experiment record.
6. Operator controls: SSM `/fin/*/kill-switch`, `/fin/*/daily-budget-usd`; scripts; CDK deploy with `contactEmail` (operator PII: one email, used for SEC fair-access header and SNS).
7. Observers read DynamoDB/S3/SQS attributes/SSM; nothing in the observer path writes.

### Assets
A1 AWS credentials and roles (highest). A2 Bedrock/LLM spend. A3 Paper ledgers and audit trail (integrity). A4 Transcripts and news bodies (S3). A5 Quote tape. A6 Kill switch and budget parameters. A7 Operator email. A8 Source code and dependencies. A9 Operator host (worker, dashboard, printer).

### Assumptions

- **AS1.** No brokerage is connected anywhere. Fills are simulated against live quotes, so a wrong decision cannot cause financial loss; the harm ceiling for decision-integrity threats is a corrupted experiment record.
- **AS2.** Every input the agents read is public and untrusted: news feeds, SEC filings, web grounding results, quote APIs. Content may be adversarial (prompt injection) or wrong.
- **AS3.** AWS services (Bedrock, EventBridge, SQS, DynamoDB, S3, SSM) and the Nova grounding runtime are trusted under the shared-responsibility model; model outputs are not trusted.
- **AS4.** Single operator, single AWS account, no end users. No surface listens on a non-loopback interface; the dashboard binds 127.0.0.1.
- **AS5.** The sample is not production-ready. Anyone deploying it does so into their own account, pays their own Bedrock costs, and sets their own budget and kill switch.
- **AS6.** The worker host or container is controlled by the adopter, and the worker's identity holds only the stack's WorkerPolicy, preferably as a role or short-lived credentials rather than long-lived access keys.
- **AS7.** Nova web grounding queries stay inside AWS and results are treated as data. The proprietary Claude Agent SDK and its bundled runtime are trusted as shipped by Anthropic.
- **AS8.** The replay bench is isolated by construction: separate archive, rule and queue, a simulated book, as-of quotes, and refusal of live URLs. It never writes to live tables or the quote tape.

---

## 2. What can go wrong

| # | Threat (grammar) | STRIDE | Priority | Status | Mitigations |
|---|---|---|---|---|---|
| T01 | An internet-based actor who can place content in a public feed the pollers ingest (a press release, an 8-K exhibit, a linked article) can embed instructions aimed at the investigator model inside that content, which leads to the agent submitting buys, sells, shorts or watchlist entries the evidence does not support, resulting in reduced integrity of paper ledgers and audit trail, experiment results. | TE | High | Identified (open or residual) | M01, M02, M03, M04, M05, M06, M10, M27 |
| T02 | An internet-based actor who can rank content in the web index that Nova grounding queries can embed instructions in a page the grounding model reads, which leads to a poisoned observation reaching the investigator and biasing its decision, resulting in reduced integrity of paper ledgers and audit trail. | T | Medium | Resolved | M02, M03, M01, M04, M05, M27 |
| T03 | An internet-based actor who controls the link field of an entry in an ingested feed can point the event URL at a loopback, private or link-local address that read_source then fetches, which leads to an internal endpoint being read through the worker, including instance metadata credentials when the worker runs on EC2 or ECS, resulting in reduced confidentiality and integrity of AWS credentials and roles, internal services on the worker host. | IE | High | Resolved | M07, M01, M17 |
| T04 | An internet-based actor who can generate many novel headlines in ingested feeds, or an upstream feed malfunction can trigger investigations at volume, which leads to Bedrock and Nova spend beyond what the operator intended, resulting in reduced availability of Bedrock/LLM spend. | D | High | Resolved | M08, M09, M10, M11, M06 |
| T05 | An actor with PutEvents on the bus or SendMessage on a news queue such as an operator running the smoke script or a mis-scoped principal can publish fabricated NewsItem events, which leads to real paper fills and, as in 2026-08, a reset book driven by data that never happened, resulting in reduced integrity of paper ledgers and audit trail. | ST | Medium | Resolved | M12, M13, M14, M15, M05 |
| T06 | An external actor who compromises the worker host or container, or obtains the worker identity's credentials, can use the credentials the v2/v3 worker runs with against the account, which leads to access to everything those credentials grant: WorkerPolicy's queues, tables, bucket and Bedrock models, or more if the adopter attached broader permissions, resulting in reduced confidentiality and integrity and availability of AWS credentials and roles, trading tables, transcripts and Bedrock spend. | EI | Medium | Resolved | M16, M17, M12 |
| T07 | A compromised or misbehaving Lambda function holding a broader IAM grant than its task needs can act on resources outside its stage, which leads to lateral movement inside the account, resulting in reduced integrity and confidentiality of AWS credentials and roles. | E | Low | Resolved | M12 |
| T08 | An actor with read access to the NewsBodies bucket (the transcript bucket) can read investigation transcripts and fetched article bodies, which leads to disclosure of the agent's reasoning and third-party content, and a place where injected content persists for 30 days, resulting in reduced confidentiality of transcripts and news bodies. | I | Low | Resolved | M18, M12, M25 |
| T09 | An actor with write access to the trading tables (operator credentials or an over-privileged function) can alter positions, cash or audit rows, which leads to a falsified experiment record that the reports and letter would present as real, resulting in reduced integrity of paper ledgers and audit trail, quote tape. | TR | Low | Resolved | M19, M05, M12 |
| T10 | An actor with ssm:PutParameter in the account can flip a kill switch off or raise the daily budget, which leads to the operator's stop and spend controls being silently defeated, resulting in reduced integrity and availability of kill switch and budget parameters, Bedrock/LLM spend. | TE | Medium | Resolved | M12, M11 |
| T11 | An external actor who compromises an upstream npm or crates.io package used by the worker, the dashboard or CDK synth can execute code in the worker process or at synth time, which leads to credential theft on the worker host or altered decisions, resulting in reduced integrity and confidentiality of AWS credentials and roles, source code and dependencies. | TE | Medium | Identified (open or residual) | M20, M21, M01 |
| T12 | An external actor or upstream outage such as SEC fair-access throttling, a quote API rate limit or Bedrock throttling can stall the pipeline or drop events, which leads to positions going unwatched and news going uninvestigated, resulting in reduced availability of paper ledgers and audit trail. | D | Low | Resolved | M22, M09, M11 |
| T13 | An operator or reviewer after the fact can be unable to attribute a fill to the evidence and reasoning that produced it, which leads to an unexplainable trade in the record, resulting in reduced non-repudiation of paper ledgers and audit trail. | R | Low | Resolved | M05 |
| T14 | An actor on the worker host or local network can reach the dashboard, which leads to reading the book, logs and letters, or triggering a harmless refresh, resulting in reduced confidentiality of worker host. | I | Low | Resolved | M23 |
| T15 | A contributor preparing the public release can commit a credential, an internal hostname or operator PII, which leads to disclosure in the published repository, resulting in reduced confidentiality of operator email, source code and dependencies. | I | Medium | Resolved | M24, M21 |
| T16 | An actor with CloudWatch Logs or worker-log access can read function or worker logs, which leads to exposure of anything sensitive that was logged, resulting in reduced confidentiality of worker host. | I | Low | Resolved | M25 |
| T17 | A compromised or misbehaving model inside the Agent SDK loop can attempt actions on the host or the network outside the fin tools, which leads to code execution, file access or exfiltration from the worker, resulting in reduced integrity and confidentiality of worker host, AWS credentials and roles. | E | High | Resolved | M01, M04, M05 |
| T18 | An internet-based actor via injected or false content the v3 agent reads can cause false facts or exposure links to be recorded in the shared world model, which leads to future triage and decisions being biased by poisoned knowledge, resulting in reduced integrity of paper ledgers and audit trail, experiment results. | T | Medium | Resolved | M26, M05, M27 |

### Threat notes

**T01 — Tampering, Elevation of privilege; priority High; Identified (open or residual).**  
Residual by design: the experiment measures the model's unassisted judgment, so a persuasive injection can still move a paper position. The blast radius is bounded to the paper book (M04) and every such decision is auditable (M05).  
Mitigations: M01, M02, M03, M04, M05, M06, M10, M27. Assumptions: AS1, AS2.

**T02 — Tampering; priority Medium; Resolved.**  
Nova's runtime filters instruction-bearing content and the SEARCH_SYSTEM prompt repeats the rule; the master model still never sees the raw page.  
Mitigations: M02, M03, M01, M04, M05, M27. Assumptions: AS2, AS7.

**T03 — Information disclosure, Elevation of privilege; priority High; Resolved.**  
Resolved by the outbound URL guard (M07): scheme, port and resolved-address checks on every hop. Residual: DNS rebinding between check and connect, which IMDSv2 with hop limit 1 closes for the metadata service on EC2 or ECS; whatever the identity, WorkerPolicy bounds what it can do (M17).  
Mitigations: M07, M01, M17. Assumptions: AS2, AS6.

**T04 — Denial of service; priority High; Resolved.**  
Ceiling is the SSM daily budget ($100/arm as of 2026-09-06) plus per-run caps; the breaker trips and audits itself, and an independent CloudWatch alarm pages the operator.  
Mitigations: M08, M09, M10, M11, M06. Assumptions: AS5.

**T05 — Spoofing, Tampering; priority Medium; Resolved.**  
The smoke script is gone (M15); PutEvents is held only by the pollers and stages and SendMessage only by the bus rules (M12); the rule against synthetic events stands (M13) and the bench is the test path (M14). Residual: an operator with admin credentials can still publish by hand.  
Mitigations: M12, M13, M14, M15, M05. Assumptions: AS1, AS8.

**T06 — Elevation of privilege, Information disclosure; priority Medium; Resolved.**  
Mitigated by the stack's least-privilege WorkerPolicy (M17) and provider-chain credentials (M16): no IAM actions and no SSM writes, so a stolen worker identity cannot escalate, flip the kill switch or raise the budget. Residual: it can still read and write the paper books and spend Bedrock up to the daily budget; attaching broader permissions than WorkerPolicy is the adopter's risk.  
Mitigations: M16, M17, M12. Assumptions: AS6.

**T07 — Elevation of privilege; priority Low; Resolved.**  
Reviewed 2026-09-19: grants are per function and per resource. The only wildcards are cloudwatch:PutMetricData (a resource-agnostic API) and Bedrock model ARNs limited to anthropic.* models and inference profiles.  
Mitigations: M12.

**T08 — Information disclosure; priority Low; Resolved.**  
Contents are public news plus model reasoning; no PII and no secrets. Bucket is private, encrypted, versioned and expires objects after 30 days.  
Mitigations: M18, M12, M25. Assumptions: AS4.

**T09 — Tampering, Repudiation; priority Low; Resolved.**  
Atomic writes, append-only audit rows, transcripts as an independent record, PITR for recovery, and explicit correction rows make tampering detectable and recoverable.  
Mitigations: M19, M05, M12. Assumptions: AS1.

**T10 — Tampering, Elevation of privilege; priority Medium; Resolved.**  
Only operator principals can write the parameters (the risk gate has read-only). The spend alarm does not depend on the parameter, and CloudTrail records every PutParameter.  
Mitigations: M12, M11. Assumptions: AS4.

**T11 — Tampering, Elevation of privilege; priority Medium; Identified (open or residual).**  
Lockfiles plus ASH (Grype, Syft, npm audit), cargo audit and npm audit gate every push (M21). 2026-09-19 removed nine advisories; 2026-09-30 replaced cargo-lambda-cdk (bundled js-toml/lodash-es) with a local construct and updated fast-uri/ip-address; brace-expansion bundled inside aws-cdk-lib is suppressed until 2026-12-31 (synth-time only, fix is upstream). 2026-10-01, from the first GitLab CI runs: h2 0.4.19, rustls 0.23.45 and rust_decimal 1.43.0 (drops rkyv 0.7), hono 4.13.9 through an npm override, and `min-release-age=7` in both `.npmrc` files so a freshly published version is not resolved. The Agent SDK bundles a Claude Code runtime, a trust placed in Anthropic's package.  
Mitigations: M20, M21, M01. Assumptions: AS7.

**T12 — Denial of service; priority Low; Resolved.**  
A paper experiment, so availability loss is a data gap, not a financial one; the letter and dashboard both report gaps explicitly.  
Mitigations: M22, M09, M11. Assumptions: AS5.

**T13 — Repudiation; priority Low; Resolved.**  
Every decision links news id → triage → decision (model, cost, turns) → execution → outcome score, with the full transcript in S3.  
Mitigations: M05.

**T14 — Information disclosure; priority Low; Resolved.**  
The dashboard binds loopback and is read-only.  
Mitigations: M23. Assumptions: AS4.

**T15 — Information disclosure; priority Medium; Resolved.**  
Resolved for the first release by M24: the export is scrubbed and scanned clean, and CI re-runs detect-secrets, Ferret and the scrub check on every push. Residual: a scanner can miss a secret format it does not know, and git history is not scanned because the published repository starts from a single squashed commit.  
Mitigations: M24, M21.

**T16 — Information disclosure; priority Low; Resolved.**  
Logs carry headlines, decisions, costs and errors; the environment holds names and URLs only; credentials are never logged.  
Mitigations: M25.

**T17 — Elevation of privilege; priority High; Resolved.**  
Built-in tools are disabled and only the in-process fin MCP server is allowed; the model can only read prices and documents and submit paper decisions.  
Mitigations: M01, M04, M05. Assumptions: AS7.

**T18 — Tampering; priority Medium; Resolved.**  
The gate resolves instruments, checks basins and live prices, and uses a fail-closed judge; every proposal is audited and facts expire. Residual: the judge is itself a model.  
Mitigations: M26, M05, M27. Assumptions: AS2.

---

## 3. What are we going to do about it

| # | Mitigation | Status |
|---|---|---|
| M01 | Agent tool confinement. `investigate.ts` runs the Agent SDK with `allowedTools: ["mcp__fin__*"]` and every built-in tool disabled (`BUILTIN_TOOLS_OFF`): no shell, file, or general network access — the model's whole world is the in-process `fin` MCP server in `tools.ts` (quotes, primary sources, grounding, portfolio reads, `submit_decision`). Schemas are plain Zod so the server cannot silently expose nothing. | Implemented |
| M02 | Content-is-data prompt rules. `websearch.ts` SEARCH_SYSTEM tells the grounding model that web content is data, never instructions, to flag embedded instructions rather than follow them, and caps the observation at 300 words. The investigator prompt (`prompts.ts` `contentIsDataSection`, default since 2026-10-01) extends the rule to everything from outside the system: the event's headline and summary (including the enrichment's `Filing summary:` line), every `read_source` document, web_search observations, search_markets titles and descriptions, and past rationales. Text addressed to the model is treated as a fact about its author, named in the rationale, and lowers the source's weight; instructions come only from the system prompt. Benched before it went live (replay bench, 2026-09-17..24, 17 events: the same call as the previous prompt on 15, no false injection flags, equal cost) and probed offline with crafted events carrying an embedded trade instruction (no fill either way; only the new prompt named the injection). The `no-content-rule` bench variant keeps the previous prompt as a control. | Implemented |
| M03 | Perception/reasoning split. The master model never reads raw pages: Nova grounding returns a grounded observation with cited URLs; `read_source` caps fetched bytes (MAX_FETCH_BYTES) and keeps only the filing plus EX-99 exhibits; 8-Ks arrive as a Haiku summary (`enrich.ts`). | Implemented |
| M04 | Paper-broker invariants (`exec.ts`, `ledger.ts`, `pending.ts`): cash never negative, total short exposure ≤ equity (no leverage), fills capped to 25% of visible depth, quotes older than `maxQuoteAgeSecs` (20 min) refused, adverse fill at max(half-spread, 2 bps), reducing remainders park as reduce-only working orders. v1 adds a deterministic risk gate (MIN_CONFIDENCE 0.65, 1 h cooldown). There is no real broker to reach. | Implemented |
| M05 | End-to-end audit trail: one `NEWS#<id>` row per stage (`v2-triage`, `v2-skipped`, `v2-decision` with model and errored flags, `v2-execution`, `v2-order-parked`…), standing theses, outcome scores at 1h/1d/7d, full transcripts in S3, and a daily letter whose Coverage section reports gaps and skips. | Implemented |
| M06 | Kill switches: SSM `/fin/kill-switch` (v1 risk gate), `/fin/v2/kill-switch`, `/fin/v3/kill-switch`; `scripts/kill-switch*.sh`; the worker checks the parameter every loop and leaves messages in the queue when it is on. The v2/v3 worker fails closed: an unreadable kill switch (missing parameter, denied read, SSM outage) counts as on (`budget.ts` `killSwitchOn`, 2026-10-07); the v1 risk gate's read error fails the invocation, so nothing is approved. | Implemented |
| M07 | Outbound URL guard (`v2/src/urlguard.ts`, 2026-09-22) on every `read_source` fetch, EDGAR included: https only (an `http:` link is upgraded, never fetched in clear), default port only, no userinfo; the hostname is resolved and refused if any address is loopback, RFC1918, CGNAT, link-local (169.254.0.0/16 — the EC2/ECS metadata endpoints), unique-local (fc00::/7, incl. fd00:ec2::254), NAT64, multicast or reserved, with IPv4-mapped IPv6 judged by the embedded address; redirects are followed by hand (at most 3) and every hop is re-checked. Unit-tested in `test/urlguard.test.ts`. The Rust pollers fetch only operator-configured feed URLs, never a URL taken from content. Residual: DNS rebinding between the check and the connect — adopters running the worker on EC2 or ECS should require IMDSv2 with hop limit 1, and the identity it could reach is bounded by WorkerPolicy (M17). | Implemented |
| M08 | Spend breaker (`budget.ts`): daily cap from SSM `/fin/<arm>/daily-budget-usd`, the last 20% reserved for position management, `maxInvestigationsPerDay`, per-run `maxBudgetUsd` and `maxTurns`, Nova grounding cost folded into the run's spend. A tripped breaker is audited (`v2-skipped`) and shown on the dashboard. Fails closed: an unreadable or non-numeric daily budget allows no investigation, priority included (2026-10-07; it used to fall back to $25). | Implemented |
| M09 | Idempotency and dedupe: `claimNews` (one investigation per news id), exact-headline dedupe window (`recent.ts`), `maxNewsAgeHours` drop, SQS visibility timeout longer than an investigation, DLQ after 3 receives. | Implemented |
| M10 | Triage gate: Haiku materiality scoring before any expensive call (v1 threshold 0.6; v2 `triage.ts` with a lower bar only for held symbols). Cheap model first, expensive model only for what passes. | Implemented |
| M11 | Alarms: CloudWatch error alarms on every decision-path function and a Bedrock spend breaker alarm, all to SNS `fin-alerts` → operator email (the `contactEmail` context, required at deploy). | Implemented |
| M12 | Least-privilege IAM in `infra/lib/fin-stack.ts`: per-function grants (table read/write, bus PutEvents, bucket write or read, SSM read for the kill switch, SNS publish for the digest). Bedrock policy scoped to `anthropic.*` foundation models and `us.anthropic.*` inference profiles. Only pollers and stages hold PutEvents. | Implemented |
| M13 | Operational rule: never publish synthetic or test events onto the live bus or queues (the rule in `docs/OPERATIONS.md`, set after the 2026-08 smoke-event incident that caused a real paper fill and a book reset). Testing goes through the replay bench only. | Implemented |
| M14 | Bench isolation (`replay.ts`, `bench/run.ts`, `quotes/asof.ts`): separate archive, replay rule and queue; simulated book; quotes as-of the event; `bench: true` refuses live URLs; no tape writes; results in `BENCHSUM` rows only. | Implemented |
| M15 | `scripts/v2-smoke.sh` — the one script that published synthetic events onto the live bus, and caused the 2026-08 fill and book reset — was deleted on 2026-09-22; the operator skill and agents that named it now forbid any put-events or send-message onto the live bus or news queues. Testing goes through the replay bench (M14). | Implemented |
| M16 | Credentials from the AWS SDK default provider chain only: none in the repo, the compose file or `.env`; the profile directory is mounted read-only into the containers; an ECS task or EC2 instance role is the recommended identity, and short-lived credentials are preferred everywhere else. | Implemented |
| M17 | Least-privilege worker identity: the stack's `WorkerPolicy` (output `WorkerPolicyArn`, `infra/lib/fin-stack.ts`) grants the two queues, the trading tables and the tape, the transcript bucket, read-only SSM parameters, the bench archive and replay, and Bedrock invoke on the named models (including the Nova search model) and Nova grounding — no IAM actions, no SSM writes. `ops/README.md` tells adopters to attach it and nothing broader; `infra/test/stack.test.ts` pins its grants. | Implemented |
| M18 | Bucket hardening on `NewsBodies` (bodies + transcripts): BlockPublicAccess BLOCK_ALL, SSE-S3, 30-day expiry with matching non-current-version expiry, versioning (2026-09-19), auto-delete on stack destroy; only pollers write and analysis reads. | Implemented |
| M19 | Ledger integrity: atomic DynamoDB transactions over snapshot, position and order (`ledger.ts`); append-only audit rows; point-in-time recovery on all four tables (2026-09-19); any manual reversal is an explicit `v2-book-correction` row written by `admin/unwind-legacy` (dry-run by default), never a silent edit. | Implemented |
| M20 | Dependency hygiene: committed lockfiles; ASH policy in `.ash/.ash.yaml` (Grype/Syft, Semgrep, Checkov, detect-secrets) plus `npm audit`/`cargo update` in the release process. 2026-09-19: AWS SDK crates moved off the legacy rustls 0.21 chain, vitest/vite/esbuild and aws-cdk-lib upgraded; 2026-09-30: `cargo-lambda-cdk` (bundled js-toml/lodash-es advisories) replaced by `infra/lib/rust-function.ts`, fast-uri/ip-address updated; brace-expansion bundled inside `aws-cdk-lib` suppressed with a 2026-12-31 expiry pending upstream. | Implemented |
| M21 | CI on the published repository: `.gitlab-ci.yml` (GitLab, where the repository lives; green since 2026-10-01) and `.github/workflows/ci.yml` (the same gates for a GitHub mirror, every Action pinned to a full commit SHA). Every image pinned by digest from ECR Public and every tool install pinned (ASH by commit, Ferret 1.10.0, detect-secrets 1.5.0, cargo-audit 0.22.2; in GitLab's ASH local mode Syft, Grype and Opengrep by checksum, cfn-nag from ASH's Gemfile.lock, Bandit, Checkov and Semgrep at exact versions in `.ash/.ash.yaml`). Jobs: Rust tests and cargo audit, v2 typecheck/tests/npm audit, infra tests and cdk-nag through `cdk synth`, ASH on the synthesized stack (fails on findings and on any scanner that could not run), Ferret (fails on any unsuppressed high/medium hit), detect-secrets, the scrub, SPDX and `.env.example` checks, and the threat-model render check. GitLab's shared runners allow no privileged containers, so ASH runs in local mode there (`scripts/ci/ash-local.sh`) rather than container mode. | Implemented |
| M22 | Availability controls: DLQs on every queue and, since 2026-09-19, on every Lambda (`FunctionDlq`); 4–14 day retention; SEC fair-access User-Agent (`EDGAR_CONTACT`); quote-source fallbacks (Kraken → Yahoo for wide fiat books); stale-quote refusal; processing gaps reported by the letter and dashboard. | Implemented |
| M23 | Observer surfaces are loopback-only and read-only: `dashboard.ts` listens on 127.0.0.1:4310; it has no write path to AWS. | Implemented |
| M24 | Secrets and PII scanning before publication (2026-09-22, on the exported tree): detect-secrets 1.5.0 against `.secrets.baseline` (hook form, fails on anything new) and Ferret 1.10 (`--checks SECRETS,CREDIT_CARD,SSN,PASSPORT,EMAIL,METADATA`, high/medium) clean; the four Ferret hits that remain are reviewed false positives in `.ferret-scan-suppressions.yaml`, each with a reason and an expiry. `scripts/oss/scrub-check.sh` fails the export on operator-specific text (hostnames, account id, credential tooling, local paths), and the export drops the operator's notes, letters and local tooling entirely. CI repeats all three on every push (M21). | Implemented |
| M25 | Nothing sensitive is logged or stored in configuration: Lambda environment holds table names, queue URLs and parameter names; the worker logs headlines, decisions and costs; credentials come from roles or the SDK provider chain and are never written. | Implemented |
| M26 | Gated world model (v3): `gate.ts` requires instruments to resolve, checks storm↔region basins, rejects price facts more than 5% from the live quote, and asks Haiku to judge causal directness, failing closed on judge errors; every proposal is audited (`v3-world-proposal`); facts carry expiry; the curiosity loop re-investigates contradictions. | Implemented |
| M27 | Amazon Bedrock guardrail (`infra/lib/guardrail.ts`, 2026-10-02), a second layer under M02: content filters with PROMPT_ATTACK at HIGH on input, HATE / INSULTS / SEXUAL, VIOLENCE and MISCONDUCT on output, the managed profanity list, and output-only PII anonymisation; distinctive blocked messages so every caller detects a block; an alarm on `InvocationsIntervened` to the alerts topic. v1 (`-c guardrail=on`, the CDK default): triage sends the feed text as Converse guard content, analysis names the guardrail on every tool-loop turn; a block is a not-material triage or a no-trade analysis, audited with `guardrail_intervened`. v2/v3 (`V2_GUARDRAIL_ID` + `V2_GUARDRAIL_VERSION`): triage, filing enrichment and the v3 link judge tag only the untrusted text (per-call random tag suffix, tag text in the content neutralised); the investigator names the guardrail through `ANTHROPIC_CUSTOM_HEADERS` and a block becomes a hold with `guardrail_intervened` on the `v2-decision` row, and any decision the run submitted before the block (or before an error) is withheld as `withheld_decisions`, never executed (`run-decisions.ts`, 2026-10-07); `read_source` and `web_search` results pass ApplyGuardrail before the agent reads them (chunked, bounded, fail-open). On in every arm of the maintainer's deployment since 2026-10-02 (v1 deployed with `-c guardrail=on`, both workers with the two variables; a fully guarded replay bench made 1,286 guardrail calls with 0 interventions and 0 errored investigations). | Implemented |

---

## 4. Did we do a good job

### Evidence

Run against the exported tree (`scripts/oss/export.sh --strict`, the exact content that is published); last re-run 2026-10-01, the Trivy, retire.js, npm audit and unit-test rows on 2026-10-07. Raw reports are attached to the release's security review, not committed here.

| Check | Result | Where |
|---|---|---|
| ASH v3.7.1, container mode, on the synthesized stack (Bandit, Semgrep, Opengrep, detect-secrets, Checkov, cfn-nag, Grype, Syft, npm audit; ASH's own cdk-nag disabled, see next row) | Every scanner PASSED, 0 actionable; 49 findings suppressed under 9 rules, each with a reason, none unused (Checkov 46 on the synthesized template, Grype 3 on the brace-expansion bundled inside `aws-cdk-lib`) | `.ash/.ash.yaml`; `ash --mode container --config .ash/.ash.yaml --ash-revision-to-install v3.7.1`. In GitLab CI the same scan runs in local mode (`scripts/ci/ash-local.sh`) with the same result |
| cdk-nag `AwsSolutionsChecks`, attached to the CDK app itself (ASH's copy cannot re-import CDK-synthesized templates) | 0 errors, 0 warnings; 57 findings suppressed, each with a reason | `infra/bin/fin.ts`, `infra/lib/nag.ts`; runs on every `cdk synth` |
| Trivy 0.69.3 (2026-10-07) on the repository (`trivy fs`: vulnerabilities, secrets, misconfiguration), on `ops/docker` (`trivy config`) and on the worker image built from `ops/docker/Dockerfile` for linux/arm64 and linux/amd64 (`trivy image`: OS packages, Node packages, secrets, misconfiguration) | Repository: only the brace-expansion bundled inside `aws-cdk-lib` (see Dependency advisories); no secrets; Dockerfile 0 misconfigurations. Image, both architectures: 0 vulnerabilities at any severity, 0 secrets, 0 misconfigurations, on Amazon Linux 2023 minimal 2023.12.20260930 (`amazonlinux:2023-minimal@sha256:5c546c87…96aa`) with `nodejs24-24.21.0`; build stage `node:24-trixie-slim@sha256:173f1258…fb66`. The image is not published: adopters build it from the Dockerfile, and a rebuild picks up newer AL2023 packages, so re-scan the image you run. Earlier images: 279 findings (65 high/critical) on `node:20-slim`, 40 (2 high) on distroless Node 24 | `ops/docker/Dockerfile`; `trivy image <your build>` |
| retire.js 5.7.0 (2026-10-07) on the repository and the installed `node_modules` of `v2/` and `infra/` (`npm ci --ignore-scripts`) | No findings | `npx retire --path .` |
| detect-secrets 1.5.0, hook form against `.secrets.baseline` | No findings; fixture lines that look like secrets carry an inline allowlist pragma | `.secrets.baseline` |
| Ferret 1.10 (secrets, PII, document metadata; high and medium confidence) | No unsuppressed findings; four reviewed false positives (the AWS vulnerability-reporting address, a systemd unit name, a fake fixture hash) in the suppression file with reasons and an expiry | `.ferret-scan-suppressions.yaml` |
| Publication scrub | `scrub-check.sh` finds no operator-specific text; the export drops operator notes, letters and local tooling | `scripts/oss/scrub-check.sh`, `scripts/oss/export.sh` |
| Dependency advisories | rustls 0.21 chain removed from `Cargo.lock`; vitest/vite/esbuild and aws-cdk-lib upgraded; 2026-09-30: `cargo-lambda-cdk` (bundled js-toml/lodash-es) replaced by `infra/lib/rust-function.ts`, fast-uri 3.1.8 / ip-address 10.7.2; brace-expansion 5.0.9 bundled inside `aws-cdk-lib` suppressed until 2026-12-31 (synth-time only, no aws-cdk-lib release carries the fix yet, `npm audit fix` cannot reach it); worker image moved off end-of-life Node 20 to Node 24 on Amazon Linux 2023 minimal, both stages pulled from ECR Public (no npm at runtime); every direct dependency pinned to its locked version (`=x.y.z` in `Cargo.toml`, exact versions and `save-exact` in both `package.json`s) and the cargo-lambda bundling image pinned by digest; 2026-10-01, found by the first GitLab CI runs: h2 0.4.19 and rustls 0.23.45 (cargo audit), rust_decimal 1.43.0 (drops rkyv 0.7), hono 4.13.9 through an npm override (Grype, XSS in `hono/jsx`), `min-release-age=7` in both `.npmrc` files (Semgrep); 2026-10-07: `@modelcontextprotocol/sdk` 1.31.0 (GHSA-6qxp-vccf-f47h), proxy-addr 2.0.8 (GHSA-jqcg-44mw-7w3h, also the only finding in the worker image before the update), source-map-js 1.2.2 (GHSA-68fv-2mgg-jv7q, dev-only); `npm audit` then reports 0 in `v2/` and only the bundled brace-expansion in `infra/` (still 5.0.9 in aws-cdk-lib 2.272.0) | `Cargo.toml`, `v2/package.json`, `infra/package.json` |
| Infrastructure hardening from the Checkov findings | PITR on all four tables, a dead-letter queue on every project Lambda, versioning on `NewsBodies` | `infra/lib/fin-stack.ts`, `infra/test/stack.test.ts` |
| Unit tests | Rust workspace green; v2 538 tests green (including the outbound URL guard, M07, and the fail-closed kill switch, budget and withheld-decision rules, M06/M08/M27); infra 33 tests green (2026-10-07) | `cargo test --workspace`, `npm test` in `v2/` and `infra/` |
| Pre-publication content security review (automated rubric scan of the published tree: Semgrep, Checkov, Bandit, cfn-guard and container-image rules) | First pass 12 findings; after the fixes 4, none actionable: three Semgrep jQuery rules on `v2/dashboard/app.js` are false positives (no jQuery; `$` wraps `querySelector`, `append` is the DOM method, text is set through `textContent`), and S3 access logging on `NewsBodies` is the accepted choice already suppressed for Checkov | `ops/docker/Dockerfile`, `Cargo.toml`, both `package.json`s, `infra/lib/rust-function.ts` |
| Independent threat-model pass (AWS Labs threat-modeling MCP server, all phases including code validation) | Same 18 threats and 26 mitigations re-derived with trust zones, crossing points and asset flows; every threat and mitigation carries file:line evidence. One gap found: M02 covers web_search results only (now marked in progress). Re-run 2026-10-01 on the published tree alone: T06 mitigated by the stack's WorkerPolicy (M17); 10 threats mitigated, 8 accepted. It also found WorkerPolicy missing the Bedrock invoke grant for the Nova search model and the bench calling `ListArchives` (which needs `Resource *`); both fixed (Nova model ARNs granted, the bench uses `DescribeArchive`) and pinned in `infra/test/stack.test.ts` | exported Threat Composer JSON kept with the review evidence |
| GitLab CI (`.gitlab-ci.yml`) on the published repository | Green on 2026-10-01: Rust tests and cargo audit, v2, infra with cdk-nag, detect-secrets, hygiene (scrub, SPDX, `.env.example`, threat-model render), Ferret, ASH local mode (every scanner PASSED, and the job fails if any scanner could not run) | `.gitlab-ci.yml`, `scripts/ci/ash-local.sh` |
| Prompt-injection rule (M02) | Replay bench, 2026-09-17..24, 17 events, previous prompt vs the content-is-data prompt: same call on 15, no false injection flags, equal cost. Offline probe (`investigate()` called directly, simulated book, nothing published or filled) with an 8-K and a news item carrying an embedded "buy" instruction: no fill under either prompt; only the new one named the injection | `v2/src/prompts.ts` `contentIsDataSection`, `v2/test/strategy.test.ts`, bench variant `no-content-rule` |
| Agent tool surface | `test/tools.test.ts` lists the `fin` MCP server exactly as the runtime does; built-in tools disabled in `investigate.ts` | `v2/test/tools.test.ts` |

### Open items, in priority order

1. **T01, T18 — accepted residual.** Prompt injection can still move a paper position; the experiment measures unassisted judgment by design. Bounded by the paper-broker invariants (M04), fully audited (M05), stoppable (M06), and since 2026-10-02 screened by a Bedrock guardrail in every arm (M27). Revisit if a real broker is ever connected — that would invalidate AS1 and this whole model.
2. **T11 — accepted residual, managed continuously.** A compromised upstream npm or crates.io package cannot be ruled out, only made unlikely and visible: lockfiles, exact pins, `min-release-age=7` in both `.npmrc` files, and cargo audit, npm audit and ASH (Grype, Syft) gating every push (M20, M21). The Agent SDK's bundled Claude Code runtime is a trust placed in Anthropic's package.

Closed on 2026-09-22: T03 (outbound URL guard, M07), T05 (the smoke script is deleted, M15), T15 (publication scrub and scans, M24). Closed on 2026-10-01: T06 (least-privilege WorkerPolicy, M17; adopters attach it to the worker identity, `ops/README.md`) and M21 (GitLab CI green on the published repository). Closed on 2026-10-01: M02 (the content-is-data rule now covers the event text, `read_source` documents and market descriptions, after a replay bench and an offline injection probe), and the 2026-09-19 infrastructure hardening (point-in-time recovery on every table, the Lambda dead-letter queue, `NewsBodies` versioning) is deployed to the maintainer's stack.

### Out of scope

- Any connection to a real brokerage or real funds (none exists; AS1). Connecting one would require a new threat model.
- Multi-tenant or public deployment (AS4). The observer surfaces are loopback-only by design; exposing them would need authentication that this sample does not implement.
- The security of Bedrock, Nova grounding and the Claude Agent SDK runtime themselves (AS3, AS7).

### Review log

| Date | Who | Change |
|---|---|---|
| 2026-09-19 | maintainer (with Claude Code) | Initial model: 18 threats, 26 mitigations, 8 assumptions; written after the ASH/Ferret scans and the fixes they drove. |
| 2026-09-22 | maintainer (with Claude Code) | Release review: T03, T05, T15 resolved; CI pinned and gating on ASH, Ferret, detect-secrets, cdk-nag and the scrub; evidence re-run on the exported tree. |
| 2026-09-30 | maintainer (with Claude Code) | GitLab security report (23 findings): dependency advisories fixed or suppressed as above; dashboard static-file containment made explicit; ShellCheck SC2115/SC2016; worker image code root-owned and read-only, HEALTHCHECK added. Later the same day: worker image on distroless Node 24 (`nodejs24-debian13`, `nonroot`), Trivy and retire.js evidence added, the stale `CKV_DOCKER_2` suppression removed. |
| 2026-09-30 | maintainer (with Claude Code) | Pre-publication content security review: both image stages from ECR Public, runtime on Amazon Linux 2023 minimal (Trivy 0 findings), direct dependencies pinned exactly, cargo-lambda image pinned by digest; 12 findings to 4, the rest false positives or accepted. Independent threat-model pass with code validation: M02 found partial and moved to in progress, new open item 4. |
| 2026-10-01 | maintainer (with Claude Code) | Threat model re-run on the published tree only: worker credentials restated for adopters (SDK provider chain, WorkerPolicy); T06 and M17 resolved; WorkerPolicy gains the Nova search model, the bench uses `DescribeArchive`; docs tell adopters to attach `WorkerPolicyArn`; stale seed and kill-switch script names fixed. |
| 2026-10-01 | maintainer (with Claude Code) | GitLab CI (`.gitlab-ci.yml`) green on the published repository, M21 resolved: runner memory overrides, ASH in local mode (no privileged containers) with Syft, Grype and Opengrep by checksum and Bandit, Checkov and Semgrep pinned exactly; the first runs drove h2, rustls, rust_decimal and hono updates and `min-release-age` in both `.npmrc` files. |
| 2026-10-01 | maintainer (with Claude Code) | M02 resolved: the investigator's content-is-data rule extended from web_search results to every external input, benched against the previous prompt and probed offline before going live. Infrastructure hardening deployed; the open items are now T01/T18 only. |
| 2026-10-02 | maintainer (with Claude Code) | M27 added: Bedrock guardrail (prompt-attack and content filters, profanity list, output PII anonymisation) on both v1 Converse paths, the v2/v3 Haiku calls, the investigator and its `read_source` / `web_search` output, with an intervention alarm and a `guardrail` bench variant. In progress until benched and switched on in the live arms. |
| 2026-10-05 | maintainer (with Claude Code) | M27 resolved: the guardrail is on in all three arms of the maintainer's deployment since 2026-10-02, verified by a fully guarded replay bench. T11 listed as an accepted residual in the open items. |
| 2026-10-07 | maintainer (with Claude Code) | Content security review advisories: the v2/v3 kill switch and daily budget fail closed on an unreadable parameter (M06, M08); an errored or guardrail-intervened investigation holds and its earlier decisions are audited as withheld, never executed (M27). Dependency gate refreshed (MCP SDK, proxy-addr, source-map-js). Trivy and retire.js re-run on the current tree and on the AL2023 / Node 24 worker image for both architectures; the evidence rows now state exactly what ran. |
