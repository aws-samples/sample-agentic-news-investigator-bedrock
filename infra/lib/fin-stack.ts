// SPDX-License-Identifier: MIT-0
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { loadArmsFile, resolveArmsFile, validateArms } from './arms';
import { FinGuardrail, parseGuardrailMode } from './guardrail';
import { applyNagSuppressions } from './nag';
import * as names from './names';
import { RustFunction } from './rust-function';
import { ArmDescriptor } from './names';
import { lambdaSourcesEnv, parseEnabledSources } from './sources';

export const DEFAULT_TRIAGE_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
export const DEFAULT_ANALYSIS_MODEL = 'us.anthropic.claude-sonnet-4-6';
export const DEFAULT_METRIC_NAMESPACE = 'Fin';
/** Production log level for the Rust Lambdas (RUST_LOG): errors, drops, refusals, kill-switch trips. */
export const DEFAULT_LOG_LEVEL = 'warn';
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
/** CloudWatch Logs retention for the Lambda log groups, in days. */
export const DEFAULT_LOG_RETENTION_DAYS = 30;

/** Rust Lambda crates, located relative to this file so synth does not depend on the cwd. */
const LAMBDAS_DIR = path.resolve(__dirname, '..', '..', 'lambdas');

/**
 * CloudFormation rejects output values above 1024 bytes. The combined ArmsEnv
 * output is skipped (with a warning) when its estimate exceeds this; the
 * per-arm `<Key>Env` outputs always carry the full block.
 */
const MAX_OUTPUT_BYTES = 1024;

export interface FinStackProps extends cdk.StackProps {
  /**
   * Arms to deploy. Defaults to the arms file: context `armsFile`, else
   * `arms.json` at the repository root (the runtime reads the same file).
   */
  readonly arms?: ArmDescriptor[];
}

/** The constructs of one agent arm, for outputs and the worker policy. */
export interface AgentArm {
  readonly arm: ArmDescriptor;
  readonly table: dynamodb.Table;
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;
  readonly killSwitch: ssm.StringParameter;
  /** Absent when the arm has no metered budget (dailyBudgetUsd null). */
  readonly dailyBudget?: ssm.StringParameter;
}

/**
 * One stack, one experiment: the shared news bus and pollers, the risk-gated
 * Lambda pipeline (the `pipeline` arm), and one queue + table + budget + kill
 * switch per `agent` arm. Every physical name comes from `names.ts`; every
 * construct id is stable for a given arm key so CloudFormation logical ids do
 * not move when the arms file grows.
 *
 * Context values (`cdk deploy -c key=value`, or `context` in cdk.json):
 *   contactEmail     REQUIRED. SEC EDGAR fair-access contact and SNS alert address.
 *   prefix           Resource-name prefix (default: the arms file's prefix, else "fin").
 *   armsFile         Path to an arms JSON file (shape: arms.schema.json at the repo root).
 *   metricNamespace  CloudWatch namespace for the digest's equity metric (default "Fin").
 *   triageModel      Bedrock model id for the pipeline's triage Lambda.
 *   analysisModel    Bedrock model id for the pipeline's analysis Lambda (default: the pipeline arm's `model`).
 *   logLevel         RUST_LOG for every Rust Lambda: error|warn|info|debug|trace (default "warn").
 *   logRetentionDays CloudWatch Logs retention for the Lambda log groups (default 30; a value
 *                    CloudWatch accepts: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, ...).
 *   enableSources    Opt-in data sources, comma-separated: yahoo, kalshi, coinbase, polymarket,
 *                    crypto-news, globenewswire, investinglive (default none). Their terms need your own permission; see lib/sources.ts and
 *                    docs/THIRD_PARTY_NOTICES.md.
 */
export class FinStack extends cdk.Stack {
  readonly prefix: string;
  readonly arms: readonly ArmDescriptor[];
  readonly agentArms: readonly AgentArm[];

  constructor(scope: Construct, id: string, props: FinStackProps = {}) {
    super(scope, id, props);

    const ctx = (key: string): string | undefined => {
      const v = this.node.tryGetContext(key);
      return v === undefined || v === null || v === '' ? undefined : String(v);
    };

    // ---------- Context ----------
    const contactEmail = ctx('contactEmail');
    if (!contactEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      throw new Error(
        'The "contactEmail" context value is required: SEC EDGAR fair-access policy needs an ' +
          'identifying contact in every request, and the alert topic subscribes it. Pass it on ' +
          'every cdk command, e.g. `cdk deploy -c contactEmail=you@example.com`, or add it under ' +
          '"context" in cdk.json.',
      );
    }

    const armsFile = props.arms ? undefined : loadArmsFile(resolveArmsFile(ctx('armsFile')));
    const arms = props.arms ? validateArms(props.arms, 'props.arms') : armsFile!.arms;
    const prefix = names.assertPrefix(ctx('prefix') ?? armsFile?.prefix ?? names.DEFAULT_PREFIX);
    const metricNamespace = ctx('metricNamespace') ?? DEFAULT_METRIC_NAMESPACE;
    const pipelineArm = arms.find((a) => a.kind === 'pipeline');
    const triageModel = ctx('triageModel') ?? DEFAULT_TRIAGE_MODEL;
    const analysisModel = ctx('analysisModel') ?? pipelineArm?.model ?? DEFAULT_ANALYSIS_MODEL;
    const logLevel = (ctx('logLevel') ?? DEFAULT_LOG_LEVEL).toLowerCase();
    if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
      throw new Error(`The "logLevel" context value must be one of ${LOG_LEVELS.join('|')}; got "${logLevel}".`);
    }
    const logRetention = retentionDays(ctx('logRetentionDays'));
    const enabledSources = parseEnabledSources(ctx('enableSources'));
    this.prefix = prefix;
    this.arms = arms;

    // ---------- Shared plumbing ----------
    const bus = new events.EventBus(this, 'Bus', { eventBusName: names.busName(prefix) });

    const busArchive = new events.Archive(this, 'BusArchive', {
      sourceEventBus: bus,
      archiveName: names.busArchiveName(prefix),
      retention: cdk.Duration.days(90),
      eventPattern: { source: events.Match.prefix('fin.') },
    });

    // The core table: the pipeline arm's ledger and every poller's dedupe store.
    const table = this.ledgerTable('Table', names.coreTableName(prefix));

    // Archived news bodies (30 days) and full agent transcripts.
    const bodyBucket = new s3.Bucket(this, 'NewsBodies', {
      versioned: true,
      lifecycleRules: [
        { expiration: cdk.Duration.days(30), noncurrentVersionExpiration: cdk.Duration.days(30) },
      ],
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const alertTopic = new sns.Topic(this, 'Alerts', {
      topicName: names.alertTopicName(prefix),
      enforceSSL: true,
    });
    alertTopic.addSubscription(new subscriptions.EmailSubscription(contactEmail));

    // ---------- Bedrock guardrail (guardrail.ts) ----------
    // Always created (no standing cost) with its version, outputs, ApplyGuardrail
    // grants and intervention alarm. `-c guardrail=on|off` only decides whether
    // the v1 Lambdas are given GUARDRAIL_ID/GUARDRAIL_VERSION. The agent workers
    // opt in through V2_GUARDRAIL_ID/V2_GUARDRAIL_VERSION in their own env.
    // Default on: a fresh deployment of the sample is screened. An operator
    // whose v1 arm is a running control experiment deploys with
    // `-c guardrail=off` so its behaviour does not change mid-series.
    const guardrailMode = parseGuardrailMode(ctx('guardrail'));
    const guardrail = new FinGuardrail(this, 'Guardrail', {
      name: `${prefix}-guardrail`,
      alertTopic,
    });
    const v1GuardrailEnv: Record<string, string> = guardrailMode === 'on' ? guardrail.env() : {};
    // ---------- end Bedrock guardrail ----------

    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUS_NAME: bus.eventBusName,
      BODY_BUCKET: bodyBucket.bucketName,
      RUST_LOG: logLevel,
      ENABLE_SOURCES: lambdaSourcesEnv(enabledSources),
    };

    // Every stage and poller is invoked asynchronously (EventBridge rules and
    // schedules). An event that fails all retries lands here instead of vanishing.
    const fnDlq = new sqs.Queue(this, 'FunctionDlq', {
      queueName: names.functionDlqName(prefix),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const rustFn = (
      name: string,
      opts: { memory?: number; timeout?: cdk.Duration; env?: Record<string, string> } = {},
    ) => {
      const fn = new RustFunction(this, name, {
        crateDir: path.join(LAMBDAS_DIR, name),
        memorySize: opts.memory ?? 256,
        timeout: opts.timeout ?? cdk.Duration.seconds(60),
        environment: { ...commonEnv, ...opts.env },
        deadLetterQueue: fnDlq,
      });
      // Retention on the log group Lambda itself creates (/aws/lambda/<fn>), set by
      // CDK's LogRetention custom resource. An explicit logs.LogGroup of that name
      // would fail on a deployed stack (the group already exists); an unnamed one
      // would move the logs to a new group and leave the old one never expiring.
      new logs.LogRetention(this, `${name}LogRetention`, {
        logGroupName: `/aws/lambda/${fn.functionName}`,
        retention: logRetention,
      });
      return fn;
    };

    // Cross-region inference profiles need InvokeModel on the profile AND on
    // the foundation model in every destination region, so both are
    // region-wildcarded; the model ids themselves are runtime configuration.
    const bedrockModelArns = [
      `arn:${this.partition}:bedrock:*::foundation-model/anthropic.*`,
      `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*.anthropic.*`,
    ];
    // Nova 2 Lite runs the agent arms' web search (V2_SEARCH_MODEL's default);
    // the worker invokes it through its cross-region inference profile.
    const novaSearchModelArns = [
      `arn:${this.partition}:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0`,
      `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/us.amazon.nova-2-lite-v1:0`,
    ];
    const bedrockInvoke = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: bedrockModelArns,
    });
    // Web search for the agent arms is Bedrock Nova web grounding, a system
    // tool invoked through InvokeTool; only principals that run a worker need it.
    const novaGrounding = new iam.PolicyStatement({
      actions: ['bedrock:InvokeTool'],
      resources: [`arn:${this.partition}:bedrock::${this.account}:system-tool/amazon.nova_grounding`],
    });

    // ---------- Ingestion (always deployed: the pollers are the news source) ----------
    const pollerEdgar = rustFn('poller-edgar', { env: { EDGAR_CONTACT: contactEmail } });
    // Publisher feeds whose terms prohibit this use (CoinDesk, Cointelegraph) or
    // could not be reviewed (GlobeNewswire) exist only when opted in (sources.ts).
    const pollerPrwire = enabledSources.has('globenewswire') ? rustFn('poller-prwire') : undefined;
    const pollerCrypto = enabledSources.has('crypto-news') ? rustFn('poller-crypto-news') : undefined;
    const pollerDisasters = rustFn('poller-disasters');
    const pollerMacro = rustFn('poller-macro');
    const pollers = [
      pollerEdgar,
      ...(pollerPrwire ? [pollerPrwire] : []),
      ...(pollerCrypto ? [pollerCrypto] : []),
      pollerDisasters,
      pollerMacro,
    ];

    for (const p of pollers) {
      table.grantReadWriteData(p);
      bus.grantPutEventsTo(p);
      bodyBucket.grantWrite(p);
    }

    // EDGAR only matters during/around US market hours (13:00-22:00 UTC covers
    // pre/post); RSS wires and crypto run 24/7.
    new events.Rule(this, 'ScheduleEdgar', {
      schedule: events.Schedule.expression('cron(*/2 13-22 ? * MON-FRI *)'),
      targets: [new targets.LambdaFunction(pollerEdgar)],
    });
    if (pollerPrwire) {
      new events.Rule(this, 'SchedulePrwire', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        targets: [new targets.LambdaFunction(pollerPrwire)],
      });
    }
    if (pollerCrypto) {
      new events.Rule(this, 'ScheduleCrypto', {
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        targets: [new targets.LambdaFunction(pollerCrypto)],
      });
    }
    // Disasters are the latency-sensitive source (USGS publishes within
    // minutes); poll every minute, 24/7.
    new events.Rule(this, 'ScheduleDisasters', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(pollerDisasters)],
    });
    new events.Rule(this, 'ScheduleMacro', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(pollerMacro)],
    });

    // ---------- Agent arms ----------
    // Each agent arm consumes the same NewsItem stream through its own SQS
    // queue (which buffers while its worker is offline) and trades into its
    // own table under its own budget and kill switch. Constructs are created
    // directly on the stack with ids derived from the arm key, so an arm's
    // logical ids never move.
    const agentArms = arms.filter((a) => a.kind === 'agent').map((arm) => this.addAgentArm(arm, prefix, bus));
    this.agentArms = agentArms;

    // ---------- Replay bench (shared) ----------
    // A normally-DISABLED rule + its own queue. The bench enables the rule,
    // StartReplays the archive with FilterArns=[this rule] (so replayed
    // events land only here), and disables it again; live events never reach
    // this queue in steady state.
    const replayDlq = new sqs.Queue(this, 'ReplayDlq', {
      queueName: names.replayDlqName(prefix),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const replayQueue = new sqs.Queue(this, 'ReplayQueue', {
      queueName: names.replayQueueName(prefix),
      retentionPeriod: cdk.Duration.days(1),
      visibilityTimeout: cdk.Duration.minutes(20),
      deadLetterQueue: { queue: replayDlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    const replayRule = new events.Rule(this, 'ReplayRule', {
      eventBus: bus,
      ruleName: names.replayRuleName(prefix),
      eventPattern: { detailType: ['NewsItem'] },
      enabled: false,
      targets: [new targets.SqsQueue(replayQueue)],
    });

    // ---------- Quote tape (shared by every agent arm) ----------
    // Every price an arm observes, stamped when it was observed (QUOTE#<symbol>/
    // TS#<iso>, MARKET#<slug>/TS#<iso>, EVENT#<news_id>/SNAP), so the replay
    // bench can price archived events as-of instead of with live quotes. TTL
    // matches the 90-day bus archive; RETAIN because the tape is the only
    // record of prices nobody filled against.
    const tapeTable = new dynamodb.Table(this, 'QuoteTapeTable', {
      tableName: names.tapeTableName(prefix),
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- Worker policy ----------
    // The agent workers run outside Lambda (a long-lived process). Attach this
    // policy to whatever principal runs them: it is the least privilege the
    // worker, the letter, the dashboard and the replay bench need.
    const workerPolicy = new iam.ManagedPolicy(this, 'WorkerPolicy', {
      managedPolicyName: names.workerPolicyName(prefix),
      description: 'Agent-arm worker, reporting and replay bench permissions for the fin stack',
    });
    tapeTable.grantReadWriteData(workerPolicy);
    table.grantReadData(workerPolicy); // the A/B report reads the pipeline arm's book
    bodyBucket.grantReadWrite(workerPolicy); // transcripts out, archived bodies in
    for (const a of agentArms) {
      a.table.grantReadWriteData(workerPolicy);
      a.queue.grantConsumeMessages(workerPolicy);
      a.killSwitch.grantRead(workerPolicy);
      a.dailyBudget?.grantRead(workerPolicy);
    }
    replayQueue.grantConsumeMessages(workerPolicy);
    replayQueue.grantPurge(workerPolicy);
    workerPolicy.addStatements(
      new iam.PolicyStatement({
        actions: ['events:EnableRule', 'events:DisableRule', 'events:DescribeRule'],
        resources: [replayRule.ruleArn],
      }),
      new iam.PolicyStatement({
        actions: ['events:StartReplay', 'events:DescribeReplay', 'events:CancelReplay', 'events:DescribeArchive'],
        resources: [busArchive.archiveArn, `arn:${this.partition}:events:${this.region}:${this.account}:replay/*`],
      }),
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [...bedrockModelArns, ...novaSearchModelArns],
      }),
      novaGrounding,
      guardrail.applyStatement(),
    );

    // ---------- Pipeline arm ----------
    const pipelineFns: lambda.Function[] = [];
    let killSwitch: ssm.StringParameter | undefined;
    let digestFn: lambda.Function | undefined;
    if (pipelineArm) {
      killSwitch = new ssm.StringParameter(this, 'KillSwitch', {
        parameterName: names.coreKillSwitchParam(prefix),
        stringValue: 'false',
        description: 'Set to "true" to stop all trading (risk gate rejects everything)',
      });

      // Agents
      const triage = rustFn('triage-agent', {
        timeout: cdk.Duration.seconds(90),
        env: { MODEL_ID: triageModel, ...v1GuardrailEnv },
      });
      table.grantReadWriteData(triage);
      bus.grantPutEventsTo(triage);
      triage.addToRolePolicy(bedrockInvoke);
      triage.addToRolePolicy(guardrail.applyStatement());

      new events.Rule(this, 'OnNewsItem', {
        eventBus: bus,
        eventPattern: { detailType: ['NewsItem'] },
        targets: [new targets.LambdaFunction(triage, { retryAttempts: 1 })],
      });

      const analysis = rustFn('analysis-agent', {
        memory: 512,
        timeout: cdk.Duration.seconds(180),
        env: { MODEL_ID: analysisModel, ...v1GuardrailEnv },
      });
      table.grantReadWriteData(analysis);
      bus.grantPutEventsTo(analysis);
      bodyBucket.grantRead(analysis);
      analysis.addToRolePolicy(bedrockInvoke);
      analysis.addToRolePolicy(guardrail.applyStatement());

      new events.Rule(this, 'OnSignalCandidate', {
        eventBus: bus,
        eventPattern: { detailType: ['SignalCandidate'] },
        targets: [new targets.LambdaFunction(analysis, { retryAttempts: 1 })],
      });

      // Risk + execution
      const riskGate = rustFn('risk-gate', {
        env: { KILL_SWITCH_PARAM: killSwitch.parameterName },
      });
      table.grantReadWriteData(riskGate);
      bus.grantPutEventsTo(riskGate);
      killSwitch.grantRead(riskGate);

      new events.Rule(this, 'OnTradeDecision', {
        eventBus: bus,
        eventPattern: { detailType: ['TradeDecision'] },
        targets: [new targets.LambdaFunction(riskGate, { retryAttempts: 1 })],
      });

      const execEngine = rustFn('exec-engine');
      table.grantReadWriteData(execEngine);
      bus.grantPutEventsTo(execEngine);

      new events.Rule(this, 'OnTradeApproved', {
        eventBus: bus,
        eventPattern: { detailType: ['TradeApproved'] },
        targets: [new targets.LambdaFunction(execEngine, { retryAttempts: 1 })],
      });

      // Digest + observability
      const digest = rustFn('digest', {
        env: { TOPIC_ARN: alertTopic.topicArn, METRIC_NAMESPACE: metricNamespace },
      });
      table.grantReadData(digest);
      alertTopic.grantPublish(digest);
      digest.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['cloudwatch:PutMetricData'],
          resources: ['*'],
          conditions: { StringEquals: { 'cloudwatch:namespace': metricNamespace } },
        }),
      );
      // 21:15 UTC weekdays is shortly after the US close; also covers the crypto day.
      new events.Rule(this, 'ScheduleDigest', {
        schedule: events.Schedule.expression('cron(15 21 * * ? *)'),
        targets: [new targets.LambdaFunction(digest)],
      });

      // Alarms: any error in the decision path pages.
      const decisionPath: lambda.Function[] = [triage, analysis, riskGate, execEngine];
      decisionPath.forEach((fn, i) => {
        new cloudwatch.Alarm(this, `Errors${i}`, {
          metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(new cwactions.SnsAction(alertTopic));
      });

      const dash = new cloudwatch.Dashboard(this, 'Dashboard', {
        dashboardName: names.dashboardName(prefix),
      });
      dash.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Pipeline invocations',
          left: decisionPath.map((fn) => fn.metricInvocations()),
        }),
        new cloudwatch.GraphWidget({
          title: 'Pipeline errors',
          left: decisionPath.map((fn) => fn.metricErrors()),
        }),
        new cloudwatch.GraphWidget({
          title: 'Portfolio equity',
          left: [
            new cloudwatch.Metric({
              namespace: metricNamespace,
              metricName: 'PortfolioEquity',
              statistic: 'Maximum',
            }),
          ],
        }),
      );

      pipelineFns.push(...decisionPath, digest);
      digestFn = digest;
    }

    // Bedrock runaway spend breaker: account-wide invocation count, every arm.
    new cloudwatch.Alarm(this, 'BedrockSpendBreaker', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'Invocations',
        statistic: 'Sum',
        period: cdk.Duration.hours(24),
      }),
      threshold: 500,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwactions.SnsAction(alertTopic));

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'BusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    if (killSwitch) new cdk.CfnOutput(this, 'KillSwitchParam', { value: killSwitch.parameterName });
    new cdk.CfnOutput(this, 'TranscriptsBucket', { value: bodyBucket.bucketName });
    new cdk.CfnOutput(this, 'ReplayQueueUrl', { value: replayQueue.queueUrl });
    new cdk.CfnOutput(this, 'ReplayRuleName', { value: replayRule.ruleName });
    new cdk.CfnOutput(this, 'ArchiveArn', { value: busArchive.archiveArn });
    new cdk.CfnOutput(this, 'TapeTable', { value: tapeTable.tableName });
    new cdk.CfnOutput(this, 'WorkerPolicyArn', { value: workerPolicy.managedPolicyArn });
    // The agent workers' V2_GUARDRAIL_ID / V2_GUARDRAIL_VERSION (opt-in; see ops/README.md).
    new cdk.CfnOutput(this, 'GuardrailId', { value: guardrail.guardrailId });
    new cdk.CfnOutput(this, 'GuardrailVersion', { value: guardrail.version });
    // Pre-parameterisation names of the four shared outputs above, kept so an
    // in-place upgrade of an existing deployment only adds outputs.
    new cdk.CfnOutput(this, 'V2TranscriptsBucket', { value: bodyBucket.bucketName });
    new cdk.CfnOutput(this, 'V2ReplayQueueUrl', { value: replayQueue.queueUrl });
    new cdk.CfnOutput(this, 'V2ReplayRuleName', { value: replayRule.ruleName });
    new cdk.CfnOutput(this, 'V2ArchiveArn', { value: busArchive.archiveArn });

    // Ready-to-paste env blocks. The runtime reads `V2_*` for every agent arm
    // (the arm key is V2_ARM); the pipeline's Lambdas get theirs from the stack.
    // Names come from names.ts as literals; only the queue URL and the bucket
    // name are deploy-time tokens, so the size estimate substitutes realistic
    // values for those two.
    const sampleQueueUrl = (queueName: string) =>
      `https://sqs.ap-southeast-2.amazonaws.com/123456789012/${queueName}`;
    const sampleBucket = 'b'.repeat(63);
    const envBlocks: string[] = [];
    let envEstimate = 0;
    for (const arm of arms) {
      const P = names.armConstructPrefix(arm.key);
      let full: string[];
      let lean: string[];
      let estimate: string;
      if (arm.kind === 'pipeline') {
        full = lean = [
          `# arm ${arm.key} (${arm.kind})`,
          `TABLE_NAME=${names.coreTableName(prefix)}`,
          `BUS_NAME=${names.busName(prefix)}`,
          `KILL_SWITCH_PARAM=${names.coreKillSwitchParam(prefix)}`,
        ];
        estimate = lean.join('\n');
      } else {
        const a = agentArms.find((x) => x.arm.key === arm.key)!;
        const r = names.armResources(prefix, arm);
        const leanFor = (queueUrl: string, bucket: string) => [
          `# arm ${arm.key} (${arm.kind})`,
          `V2_ARM=${arm.key}`,
          `V2_QUEUE_URL=${queueUrl}`,
          `V2_TABLE=${r.table}`,
          `V2_TAPE_TABLE=${names.tapeTableName(prefix)}`,
          `V2_TRANSCRIPT_BUCKET=${bucket}`,
          `V2_KILL_SWITCH_PARAM=${r.killSwitchParam}`,
          `V2_DAILY_BUDGET_PARAM=${r.dailyBudgetParam}`,
          `V2_MASTER_MODEL=${arm.model}`,
          `V2_WORLD_MODEL=${arm.worldModel ? '1' : '0'}`,
        ];
        lean = leanFor(a.queue.queueUrl, bodyBucket.bucketName);
        estimate = leanFor(sampleQueueUrl(r.newsQueue!), sampleBucket).join('\n');
        full = [
          ...lean,
          ...(arm.maxInvestigationsPerDay !== undefined ? [`V2_MAX_INVESTIGATIONS_PER_DAY=${arm.maxInvestigationsPerDay}`] : []),
          `V2_EDGAR_CONTACT=${contactEmail}`,
          `AWS_REGION=${this.region}`,
          ...(arm.effort ? [`V2_EFFORT=${arm.effort}`] : []),
        ];
      }
      envEstimate += estimate.length + 1;
      envBlocks.push(lean.join('\n'));
      new cdk.CfnOutput(this, `${P}Env`, {
        description: `Env block for arm "${arm.key}": ${arm.label}`,
        value: full.join('\n'),
      });
    }
    if (envEstimate <= MAX_OUTPUT_BYTES) {
      new cdk.CfnOutput(this, 'ArmsEnv', {
        description: 'Env block for every arm; the per-arm <Key>Env outputs carry the complete set',
        value: envBlocks.join('\n'),
      });
    } else {
      cdk.Annotations.of(this).addWarningV2(
        'fin:arms-env-too-long',
        `ArmsEnv would exceed the ${MAX_OUTPUT_BYTES}-byte output limit with ${arms.length} arms; use the per-arm <Key>Env outputs.`,
      );
    }

    scopeLogRetentionProvider(this);

    applyNagSuppressions(this, {
      tables: [table, tapeTable, ...agentArms.map((a) => a.table)],
      bucket: bodyBucket,
      functions: [...pollers, ...pipelineFns],
      metricPublisher: digestFn,
      workerPolicy,
    });
  }

  /** One agent arm: queue + DLQ + bus rule, ledger table, kill switch, daily budget. */
  private addAgentArm(arm: ArmDescriptor, prefix: string, bus: events.IEventBus): AgentArm {
    const P = names.armConstructPrefix(arm.key);
    const dlq = new sqs.Queue(this, `${P}NewsDlq`, {
      queueName: names.armNewsDlqName(prefix, arm.key),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, `${P}NewsQueue`, {
      queueName: names.armNewsQueueName(prefix, arm.key),
      retentionPeriod: cdk.Duration.days(4),
      visibilityTimeout: cdk.Duration.minutes(20), // > one full investigation
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      enforceSSL: true,
    });
    new events.Rule(this, `${P}OnNewsItem`, {
      eventBus: bus,
      eventPattern: { detailType: ['NewsItem'] },
      targets: [new targets.SqsQueue(queue)],
    });

    const table = this.ledgerTable(`${P}Table`, names.armTableName(prefix, arm));

    const who = `${arm.key}${arm.worldModel ? ' (world-model)' : ''} worker`;
    const killSwitch = new ssm.StringParameter(this, `${P}KillSwitch`, {
      parameterName: names.armKillSwitchParam(prefix, arm),
      stringValue: 'false',
      description: `Set to "true" to stop the ${who} from investigating/trading`,
    });
    // null = no metered budget for this arm (arms.schema.json); the worker's
    // budget reader falls back to its code default when the parameter is absent.
    const dailyBudget =
      arm.dailyBudgetUsd === null
        ? undefined
        : new ssm.StringParameter(this, `${P}DailyBudget`, {
            parameterName: names.armDailyBudgetParam(prefix, arm.key),
            stringValue: String(arm.dailyBudgetUsd),
            description: `Daily LLM spend ceiling (USD) for the ${arm.key} worker`,
          });

    new cdk.CfnOutput(this, `${P}QueueUrl`, { value: queue.queueUrl });
    new cdk.CfnOutput(this, `${P}TableName`, { value: table.tableName });
    new cdk.CfnOutput(this, `${P}KillSwitchParam`, { value: killSwitch.parameterName });
    if (dailyBudget) new cdk.CfnOutput(this, `${P}DailyBudgetParam`, { value: dailyBudget.parameterName });

    return { arm, table, queue, dlq, killSwitch, dailyBudget };
  }

  /** Single-table ledger layout shared by every arm: pk/sk plus the gsi1 index. */
  private ledgerTable(id: string, tableName: string): dynamodb.Table {
    const t = new dynamodb.Table(this, id, {
      tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    t.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });
    return t;
  }
}

/** The `logRetentionDays` context value as a CloudWatch retention; only values CloudWatch accepts. */
function retentionDays(raw: string | undefined): logs.RetentionDays {
  const days = raw === undefined ? DEFAULT_LOG_RETENTION_DAYS : Number(raw);
  const allowed = Object.values(logs.RetentionDays).filter(
    (v): v is logs.RetentionDays => typeof v === 'number' && v !== logs.RetentionDays.INFINITE,
  );
  if (!allowed.includes(days as logs.RetentionDays)) {
    throw new Error(
      `The "logRetentionDays" context value must be one of ${allowed.join(', ')}; got "${raw}".`,
    );
  }
  return days as logs.RetentionDays;
}

/**
 * CDK's LogRetention provider (one singleton Lambda per stack) always grants its
 * role logs:PutRetentionPolicy / logs:DeleteRetentionPolicy on "*" (aws-cdk-lib
 * adds the statement unconditionally, even with a caller-supplied role). Narrow it
 * to Lambda log groups in this account and region, the only groups it is pointed
 * at. Not /aws/lambda/<stackName>-*: CloudFormation truncates long stack names in
 * generated function names, so that prefix would not always match.
 */
function scopeLogRetentionProvider(stack: cdk.Stack): void {
  const provider = stack.node.tryFindChild('LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a');
  const policy = provider?.node.tryFindChild('ServiceRole')?.node.tryFindChild('DefaultPolicy');
  const cfn = policy?.node.defaultChild as iam.CfnPolicy | undefined;
  if (!cfn) return;
  cfn.addPropertyOverride(
    'PolicyDocument.Statement.0.Resource',
    stack.formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: '/aws/lambda/*',
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    }),
  );
}
