import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { ROOT_ARMS_FILE, loadArmsFile } from '../lib/arms';
import { FinStack } from '../lib/fin-stack';
import { BLOCKED_INPUT_MESSAGE, BLOCKED_OUTPUT_MESSAGE } from '../lib/guardrail';
import { ArmDescriptor } from '../lib/names';

const CONTACT = 'ci@example.invalid';

/** Skip `cargo lambda build`: assets are placeholders, the template is complete. */
function app(context: Record<string, unknown> = {}): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
}

function tableNames(template: Template): string[] {
  return Object.values(template.findResources('AWS::DynamoDB::Table'))
    .map((r) => r.Properties.TableName as string)
    .sort();
}

function queueNames(template: Template): string[] {
  return Object.values(template.findResources('AWS::SQS::Queue'))
    .map((r) => r.Properties.QueueName as string)
    .sort();
}

describe('FinStack with the default three-arm file', () => {
  const stack = new FinStack(app({ contactEmail: CONTACT }), 'FinStack');
  const template = Template.fromStack(stack);

  it('reads the repository arms.json (the runtime reads the same file)', () => {
    const arms = loadArmsFile(ROOT_ARMS_FILE).arms;
    expect(arms.map((a) => a.key)).toEqual(['v1', 'v2', 'v3']);
    expect(arms[0].dailyBudgetUsd).toBeNull(); // the pipeline arm has no metered budget
    expect(arms[1].worldModel).toBe(false);
    expect(arms[2].worldModel).toBe(true);
    expect(stack.prefix).toBe('fin');
  });

  it('creates the core table, one table per agent arm and the tape table', () => {
    expect(tableNames(template)).toEqual(['fin-quote-tape', 'fin-trading', 'fin-v2-trading', 'fin-v3-trading']);
  });

  it('creates a news queue and DLQ per agent arm plus the shared replay pair and the Lambda DLQ', () => {
    expect(queueNames(template)).toEqual([
      'fin-lambda-dlq',
      'fin-replay',
      'fin-replay-dlq',
      'fin-v2-news',
      'fin-v2-news-dlq',
      'fin-v3-news',
      'fin-v3-news-dlq',
    ]);
  });

  it('keeps the pre-parameterisation logical ids for the arm resources', () => {
    // A construct created directly on the stack gets logical id <constructId><8 hex>.
    const ids = Object.keys(template.toJSON().Resources);
    for (const id of ['V2Table', 'V2NewsQueue', 'V2NewsDlq', 'V2OnNewsItem', 'V2KillSwitch', 'V2DailyBudget', 'V3Table', 'V3NewsQueue', 'V3NewsDlq', 'V3OnNewsItem', 'V3KillSwitch', 'V3DailyBudget', 'Table', 'QuoteTapeTable', 'KillSwitch', 'Bus', 'BusArchive', 'NewsBodies', 'Alerts', 'ReplayQueue', 'ReplayDlq', 'ReplayRule', 'WorkerPolicy', 'FunctionDlq']) {
      expect(ids.some((x) => new RegExp(`^${id}[0-9A-F]{8}$`).test(x)), id).toBe(true);
    }
    // Point-in-time recovery is on for every table, so AwsSolutions-DDB3 needs no suppression.
    for (const t of Object.values(template.findResources('AWS::DynamoDB::Table')) as any[]) {
      expect(t.Properties.PointInTimeRecoverySpecification, t.Properties.TableName).toEqual({ PointInTimeRecoveryEnabled: true });
      expect(JSON.stringify(t.Metadata ?? {})).not.toContain('AwsSolutions-DDB3');
    }
  });

  it('names SSM parameters and the bus from the prefix and arm keys', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/fin/kill-switch' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/fin/v2/kill-switch', Value: 'false' });
    // Initial values come from the repository arms.json (the running experiment: $100/day per agent arm).
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/fin/v2/daily-budget-usd', Value: '100' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/fin/v3/daily-budget-usd', Value: '100' });
    // The pipeline arm has no metered budget, so no /fin/daily-budget-usd parameter exists.
    expect(Object.values(template.findResources('AWS::SSM::Parameter')).some((r: any) => r.Properties?.Name === '/fin/daily-budget-usd')).toBe(false);
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'fin-events' });
    template.hasResourceProperties('AWS::Events::Archive', { ArchiveName: 'fin-events-archive' });
    template.hasResourceProperties('AWS::Events::Rule', { Name: 'fin-replay-rule', State: 'DISABLED' });
  });

  it('wires the contact into EDGAR polling, the alert subscription and the env blocks', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: CONTACT });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ EDGAR_CONTACT: CONTACT }) },
    });
  });

  it('runs every Rust Lambda at RUST_LOG=warn and gives each log group 30-day retention', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function')) as any[];
    const rust = fns.filter((f) => f.Properties.Runtime === 'provided.al2023');
    // Ten crates; poller-crypto-news and poller-prwire are deployed only when opted in.
    expect(rust).toHaveLength(8);
    for (const f of rust) expect(f.Properties.Environment.Variables.RUST_LOG).toBe('warn');
    const retention = Object.values(template.findResources('Custom::LogRetention')) as any[];
    expect(retention).toHaveLength(8);
    for (const r of retention) expect(r.Properties.RetentionInDays).toBe(30);
    // The provider may only change retention, not read or delete logs.
    const providerPolicy = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('LogRetention'))![1],
    );
    expect(providerPolicy).toContain('logs:PutRetentionPolicy');
    expect(providerPolicy).not.toMatch(/logs:(Get|Filter|Delete)Log/);
    // ...and only on Lambda log groups: CDK's default "*" fails Checkov CKV_AWS_111.
    expect(providerPolicy).not.toContain('"Resource":"*"');
    expect(providerPolicy).toContain(':log-group:/aws/lambda/*');
  });

  it('passes the metric namespace to the digest and scopes its PutMetricData', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ METRIC_NAMESPACE: 'Fin' }) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Condition: { StringEquals: { 'cloudwatch:namespace': 'Fin' } },
          }),
        ]),
      },
    });
  });

  it('region-wildcards Bedrock and grants Nova grounding and the Nova search model to the worker policy', () => {
    const policies = template.findResources('AWS::IAM::ManagedPolicy');
    expect(Object.keys(policies)).toHaveLength(1);
    const json = JSON.stringify(policies);
    expect(json).toContain('bedrock:InvokeTool');
    expect(json).toContain('system-tool/amazon.nova_grounding');
    expect(json).toContain(':bedrock:*::foundation-model/anthropic.*');
    expect(json).toContain(':inference-profile/*.anthropic.*');
    // web_search's Nova 2 Lite: foundation model and its cross-region profile.
    expect(json).toContain(':bedrock:*::foundation-model/amazon.nova-2-lite-v1:0');
    expect(json).toContain(':inference-profile/us.amazon.nova-2-lite-v1:0');
    expect(json).toContain('events:DescribeArchive');
    expect(json).not.toMatch(/bedrock:us-(east|west)-\d/);
    // The pipeline Lambdas get the same region-wildcarded model ARNs.
    const lambdaPolicies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(lambdaPolicies).toContain(':inference-profile/*.anthropic.*');
    expect(lambdaPolicies).not.toMatch(/bedrock:us-(east|west)-\d/);
  });

  it('emits per-arm outputs, an ArmsEnv block and the legacy output names', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    for (const key of ['ArmsEnv', 'V1Env', 'V2Env', 'V3Env', 'V2QueueUrl', 'V2TableName', 'V2KillSwitchParam', 'V2DailyBudgetParam', 'V3QueueUrl', 'V3TableName', 'TapeTable', 'ReplayQueueUrl', 'ReplayRuleName', 'ArchiveArn', 'TranscriptsBucket', 'WorkerPolicyArn', 'V2TranscriptsBucket', 'V2ReplayQueueUrl', 'V2ReplayRuleName', 'V2ArchiveArn', 'BusName', 'TableName', 'KillSwitchParam']) {
      expect(outputs, key).toHaveProperty(key);
    }
    const armsEnv = JSON.stringify(outputs.ArmsEnv.Value);
    for (const line of ['# arm v1 (pipeline)', '# arm v2 (agent)', 'V2_ARM=v2', 'V2_ARM=v3', 'V2_TABLE=fin-v2-trading', 'V2_TAPE_TABLE=fin-quote-tape', 'V2_KILL_SWITCH_PARAM=/fin/v3/kill-switch', 'V2_DAILY_BUDGET_PARAM=/fin/v2/daily-budget-usd', 'V2_WORLD_MODEL=1', 'V2_MASTER_MODEL=us.anthropic.claude-fable-5-1', 'TABLE_NAME=fin-trading', 'V2_QUEUE_URL=', 'V2_TRANSCRIPT_BUCKET=']) {  // pragma: allowlist secret
      expect(armsEnv).toContain(line);
    }
    const v2Env = JSON.stringify(outputs.V2Env.Value);
    expect(v2Env).toContain('V2_MAX_INVESTIGATIONS_PER_DAY=200');
    expect(v2Env).toContain(`V2_EDGAR_CONTACT=${CONTACT}`);
    expect(v2Env).not.toContain('V2_EFFORT');
    expect(JSON.stringify(outputs.V3Env.Value)).toContain('V2_WORLD_MODEL=1');
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('ArmsEnv.*'))).toEqual([]);
  });

  it('skips ArmsEnv with a warning when the combined block could exceed the output limit', () => {
    const many: ArmDescriptor[] = ['a', 'b', 'c', 'd', 'e'].map((k) => ({
      key: `arm-${k}`, kind: 'agent', label: k, model: 'us.anthropic.claude-sonnet-4-6', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1,
    }));
    const stack = new FinStack(app({ contactEmail: CONTACT }), 'ManyArms', { arms: many });
    const template = Template.fromStack(stack);
    expect(template.toJSON().Outputs).not.toHaveProperty('ArmsEnv');
    expect(template.toJSON().Outputs).toHaveProperty('ArmEEnv');
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('ArmsEnv.*'))).toHaveLength(1);
  });
});

describe('FinStack context handling', () => {
  it('throws a helpful error when contactEmail is missing', () => {
    expect(() => new FinStack(app(), 'FinStack')).toThrow(/contactEmail/);
    expect(() => new FinStack(app({ contactEmail: 'not-an-email' }), 'FinStack')).toThrow(/contactEmail/);
  });

  it('prefix=demo with two agent arms produces two demo- arm tables and no pipeline', () => {
    const arms: ArmDescriptor[] = [
      { key: 'alpha', kind: 'agent', label: 'A', model: 'us.anthropic.claude-sonnet-4-6', worldModel: false, dailyBudgetUsd: 10, maxInvestigationsPerDay: 50 },
      { key: 'beta', kind: 'agent', label: 'B', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', effort: 'low', worldModel: true, dailyBudgetUsd: 5, maxInvestigationsPerDay: 20 },
    ];
    const stack = new FinStack(app({ contactEmail: CONTACT, prefix: 'demo', metricNamespace: 'Demo' }), 'DemoStack', { arms });
    const template = Template.fromStack(stack);

    expect(tableNames(template)).toEqual(['demo-alpha-trading', 'demo-beta-trading', 'demo-quote-tape', 'demo-trading']);
    expect(queueNames(template)).toEqual(['demo-alpha-news', 'demo-alpha-news-dlq', 'demo-beta-news', 'demo-beta-news-dlq', 'demo-lambda-dlq', 'demo-replay', 'demo-replay-dlq']);
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/demo/alpha/daily-budget-usd', Value: '10' });
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/demo/beta/kill-switch' });
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'demo-events' });
    template.hasResourceProperties('AWS::IAM::ManagedPolicy', { ManagedPolicyName: 'demo-worker' });

    // No pipeline arm: pollers only, no decision-path Lambdas, no core kill switch.
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).map((r) => JSON.stringify(r.Properties.Environment ?? {}));
    expect(fns.some((e) => e.includes('MODEL_ID'))).toBe(false);
    expect(Object.values(template.findResources('AWS::SSM::Parameter')).map((r) => r.Properties.Name)).not.toContain('/demo/kill-switch');
    expect(template.toJSON().Outputs).not.toHaveProperty('KillSwitchParam');
    expect(JSON.stringify(template.toJSON().Outputs.BetaEnv.Value)).toContain('V2_EFFORT=low');
  });

  it('takes logLevel and logRetentionDays from context and rejects bad values', () => {
    const t = Template.fromStack(new FinStack(app({ contactEmail: CONTACT, logLevel: 'INFO', logRetentionDays: '90' }), 'LogStack'));
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ RUST_LOG: 'info' }) } });
    t.hasResourceProperties('Custom::LogRetention', { RetentionInDays: 90 });
    expect(() => new FinStack(app({ contactEmail: CONTACT, logLevel: 'verbose' }), 'Bad')).toThrow(/logLevel/);
    expect(() => new FinStack(app({ contactEmail: CONTACT, logRetentionDays: '31' }), 'Bad')).toThrow(/logRetentionDays/);
    expect(() => new FinStack(app({ contactEmail: CONTACT, logRetentionDays: 'forever' }), 'Bad')).toThrow(/logRetentionDays/);
  });

  it('reads an explicit armsFile from context', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-arms-'));
    const file = path.join(dir, 'arms.json');
    fs.writeFileSync(file, JSON.stringify({
      prefix: 'lab',
      arms: [
        { key: 'v1', kind: 'pipeline', label: 'pipeline', model: 'us.anthropic.claude-sonnet-4-6', worldModel: false, dailyBudgetUsd: 0, maxInvestigationsPerDay: 0 },
        { key: 'x', kind: 'agent', label: 'x', model: 'm', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 },
      ],
    }));
    const stack = new FinStack(app({ contactEmail: CONTACT, armsFile: file }), 'LabStack');
    expect(stack.prefix).toBe('lab');
    expect(tableNames(Template.fromStack(stack))).toEqual(['lab-quote-tape', 'lab-trading', 'lab-x-trading']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects malformed arms', () => {
    const bad = (arms: unknown) => () => new FinStack(app({ contactEmail: CONTACT }), 'Bad', { arms: arms as ArmDescriptor[] });
    expect(bad([])).toThrow(/non-empty/);
    expect(bad([{ key: 'Bad', kind: 'agent', label: 'l', model: 'm', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 }])).toThrow(/arm key/);
    expect(bad([
      { key: 'a', kind: 'pipeline', label: 'l', model: 'm', worldModel: false, dailyBudgetUsd: 0, maxInvestigationsPerDay: 0 },
      { key: 'b', kind: 'pipeline', label: 'l', model: 'm', worldModel: false, dailyBudgetUsd: 0, maxInvestigationsPerDay: 0 },
    ])).toThrow(/only one arm/);
    expect(bad([
      { key: 'a', kind: 'agent', label: 'l', model: 'm', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 },
      { key: 'a', kind: 'agent', label: 'l', model: 'm', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 },
    ])).toThrow(/duplicated/);
  });
});

describe('Bedrock guardrail', () => {
  const guarded = Template.fromStack(new FinStack(app({ contactEmail: CONTACT }), 'FinStack'));
  const unguarded = Template.fromStack(new FinStack(app({ contactEmail: CONTACT, guardrail: 'off' }), 'FinStack'));

  it('creates one guardrail with the agreed policies and distinctive blocked messages', () => {
    guarded.resourceCountIs('AWS::Bedrock::Guardrail', 1);
    guarded.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
    const g = Object.values(guarded.findResources('AWS::Bedrock::Guardrail'))[0] as any;
    const p = g.Properties;
    expect(p.BlockedInputMessaging).toBe('FIN_GUARDRAIL_BLOCKED_INPUT');
    expect(p.BlockedOutputsMessaging).toBe('FIN_GUARDRAIL_BLOCKED_OUTPUT');
    const filters = Object.fromEntries(
      p.ContentPolicyConfig.FiltersConfig.map((f: any) => [f.Type, `${f.InputStrength}/${f.OutputStrength}`]),
    );
    expect(filters).toEqual({
      HATE: 'LOW/HIGH',
      INSULTS: 'LOW/HIGH',
      SEXUAL: 'LOW/HIGH',
      VIOLENCE: 'NONE/HIGH',
      MISCONDUCT: 'NONE/MEDIUM',
      PROMPT_ATTACK: 'HIGH/NONE',
    });
    expect(p.WordPolicyConfig.ManagedWordListsConfig).toEqual([{ Type: 'PROFANITY' }]);
    const pii = p.SensitiveInformationPolicyConfig.PiiEntitiesConfig;
    expect(pii.map((e: any) => e.Type).sort()).toEqual(
      ['CREDIT_DEBIT_CARD_NUMBER', 'EMAIL', 'PHONE', 'US_SOCIAL_SECURITY_NUMBER'],
    );
    for (const e of pii) {
      expect(e).toMatchObject({ Action: 'ANONYMIZE', InputEnabled: false, OutputEnabled: true });
    }
    expect(p.TopicPolicyConfig).toBeUndefined();
  });

  it('is created with -c guardrail=off too; only the v1 env changes', () => {
    unguarded.resourceCountIs('AWS::Bedrock::Guardrail', 1);
    const withId = (t: Template) =>
      (Object.values(t.findResources('AWS::Lambda::Function')) as any[]).filter(
        (f) => f.Properties.Environment?.Variables?.GUARDRAIL_ID,
      );
    const on = withId(guarded);
    expect(on).toHaveLength(2); // triage-agent and analysis-agent
    for (const f of on) {
      expect(f.Properties.Environment.Variables.MODEL_ID).toBeDefined();
      expect(f.Properties.Environment.Variables.GUARDRAIL_VERSION).toBeDefined();
    }
    expect(withId(unguarded)).toHaveLength(0);
  });

  it('rejects a guardrail context value other than on or off', () => {
    expect(() => new FinStack(app({ contactEmail: CONTACT, guardrail: 'yes' }), 'FinStack')).toThrow(/on" or "off/);
  });

  it('grants ApplyGuardrail on the guardrail ARN to the v1 agents and the worker policy, in both modes', () => {
    for (const t of [guarded, unguarded]) {
      const docs = JSON.stringify([
        ...Object.values(t.findResources('AWS::IAM::Policy')),
        ...Object.values(t.findResources('AWS::IAM::ManagedPolicy')),
      ]);
      const grants = docs.match(/"Action":"bedrock:ApplyGuardrail","Effect":"Allow","Resource":\{"Fn::GetAtt":\["Guardrail[A-Za-z0-9]+","GuardrailArn"\]\}/g) ?? [];
      expect(grants.length).toBe(3);
    }
  });

  it('alarms on any intervention through the alert topic and outputs the id and version', () => {
    const alarms = Object.values(guarded.findResources('AWS::CloudWatch::Alarm')) as any[];
    const a = alarms.find((x) => JSON.stringify(x.Properties.Metrics ?? []).includes('InvocationsIntervened'));
    expect(a).toBeDefined();
    expect(JSON.stringify(a.Properties.Metrics)).toContain('AWS/Bedrock/Guardrails');
    expect(a.Properties.Threshold).toBe(1);
    expect(a.Properties.AlarmActions).toHaveLength(1);
    guarded.hasOutput('GuardrailId', {});
    guarded.hasOutput('GuardrailVersion', {});
  });

  it('uses the same blocked messages as the v2 workers and the v1 Lambdas, which detect blocks by them', () => {
    const repo = path.resolve(__dirname, '..', '..');
    const sources = [
      fs.readFileSync(path.join(repo, 'v2', 'src', 'guardrail.ts'), 'utf8'),
      fs.readFileSync(path.join(repo, 'crates', 'fin-llm', 'src', 'guardrail.rs'), 'utf8'),
    ];
    for (const src of sources) {
      expect(src).toMatch(new RegExp(`BLOCKED_INPUT_MESSAGE[^=]*= "${BLOCKED_INPUT_MESSAGE}"`));
      expect(src).toMatch(new RegExp(`BLOCKED_OUTPUT_MESSAGE[^=]*= "${BLOCKED_OUTPUT_MESSAGE}"`));
    }
  });
});

describe('cdk-nag', () => {
  it('synth has zero unsuppressed AwsSolutions errors for the default arms', () => {
    const a = app({ contactEmail: CONTACT });
    const stack = new FinStack(a, 'FinStack');
    Aspects.of(a).add(new AwsSolutionsChecks({ verbose: true }));
    Template.fromStack(stack);
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
  });

  it('also for a two-agent-arm deployment without a pipeline', () => {
    const a = app({ contactEmail: CONTACT, prefix: 'demo' });
    const stack: Stack = new FinStack(a, 'DemoStack', {
      arms: [
        { key: 'alpha', kind: 'agent', label: 'A', model: 'm', worldModel: false, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 },
        { key: 'beta', kind: 'agent', label: 'B', model: 'm', worldModel: true, dailyBudgetUsd: 1, maxInvestigationsPerDay: 1 },
      ],
    });
    Aspects.of(a).add(new AwsSolutionsChecks({ verbose: true }));
    Template.fromStack(stack);
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    expect(errors.map((e) => `${e.id}: ${JSON.stringify(e.entry.data)}`)).toEqual([]);
  });
});

describe('opt-in data sources (enableSources)', () => {
  const lambdaEnvs = (t: Template) =>
    Object.values(t.findResources('AWS::Lambda::Function')).map(
      (r) => (r.Properties.Environment?.Variables ?? {}) as Record<string, unknown>,
    );
  const hasFn = (t: Template, prefix: string) =>
    Object.keys(t.findResources('AWS::Lambda::Function')).some((id) => id.startsWith(prefix));
  const hasCryptoPoller = (t: Template) => hasFn(t, 'pollercryptonews');
  const hasPrwirePoller = (t: Template) => hasFn(t, 'pollerprwire');

  it('deploys no crypto-news poller and enables no price source by default', () => {
    const t = Template.fromStack(new FinStack(app({ contactEmail: CONTACT }), 'FinStack'));
    expect(hasCryptoPoller(t)).toBe(false);
    expect(hasPrwirePoller(t)).toBe(false);
    expect(Object.keys(t.findResources('AWS::Events::Rule')).some((id) => id.startsWith('ScheduleCrypto'))).toBe(false);
    for (const env of lambdaEnvs(t)) if ('TABLE_NAME' in env) expect(env.ENABLE_SOURCES).toBe('');
  });

  it('deploys what enableSources names', () => {
    const t = Template.fromStack(
      new FinStack(
        app({
          contactEmail: CONTACT,
          enableSources: 'crypto-news, Kalshi,yahoo,globenewswire,investinglive,polymarket,coinbase',
        }),
        'FinStack',
      ),
    );
    expect(hasCryptoPoller(t)).toBe(true);
    expect(hasPrwirePoller(t)).toBe(true);
    for (const env of lambdaEnvs(t)) {
      if ('TABLE_NAME' in env) expect(env.ENABLE_SOURCES).toBe('yahoo,kalshi,coinbase,polymarket,investinglive');
    }
  });

  it('rejects an unknown source', () => {
    expect(() => new FinStack(app({ contactEmail: CONTACT, enableSources: 'bloomberg' }), 'FinStack')).toThrow(
      /unknown source "bloomberg"/,
    );
  });
});
