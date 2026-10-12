// SPDX-License-Identifier: MIT-0
/**
 * The fin Bedrock guardrail: one guardrail + one published version, the
 * intervention alarm, and the env/grant helpers the stack wires into callers.
 *
 * What it screens, and why these strengths:
 * - PROMPT_ATTACK on input, HIGH. News, filings and web pages are untrusted
 *   text that reaches a model which can trade. The callers tag only that text
 *   (guard content), so the system prompt is never judged as an attack.
 * - HATE / INSULTS / SEXUAL: input LOW, output HIGH. A news feed carries
 *   crime and war reporting, so input stays permissive; nothing in a trading
 *   rationale should need these.
 * - VIOLENCE and MISCONDUCT: input NONE (disasters, wars, fraud and
 *   enforcement actions are the news a trader reads), output HIGH and MEDIUM.
 * - The managed PROFANITY word list.
 * - PII on output only (ANONYMIZE): SSN, card numbers, email, phone. Filings
 *   carry officers' names and addresses legitimately; the model has no reason
 *   to emit contact data.
 * - No denied topics: the whole domain is finance, so a topic ban would block
 *   the work itself.
 *
 * The blocked messages are distinctive tokens, not prose: a block on an
 * Anthropic Messages call returns `stop_reason: end_turn` with the message as
 * the text, and through the Agent SDK it is a silent `success` at $0, so the
 * callers detect a block by comparing the text to these exact strings. The
 * same strings live in `v2/src/guardrail.ts` and `crates/fin-llm/src/guardrail.rs`;
 * `test/stack.test.ts` checks the three agree.
 *
 * Nothing here has a standing cost: a guardrail is billed per text unit it
 * evaluates, and it only evaluates when a caller names it.
 */
import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwactions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export const BLOCKED_INPUT_MESSAGE = 'FIN_GUARDRAIL_BLOCKED_INPUT';
export const BLOCKED_OUTPUT_MESSAGE = 'FIN_GUARDRAIL_BLOCKED_OUTPUT';

/** `-c guardrail=on|off`: whether the v1 Lambdas get GUARDRAIL_ID/VERSION. */
export type GuardrailMode = 'on' | 'off';

export function parseGuardrailMode(v: string | undefined): GuardrailMode {
  const mode = (v ?? 'on').trim().toLowerCase();
  if (mode !== 'on' && mode !== 'off') {
    throw new Error(`The "guardrail" context value must be "on" or "off", got "${v}".`);
  }
  return mode;
}

export interface FinGuardrailProps {
  /** Guardrail name (prefix-derived; unique per account and region). */
  name: string;
  /** Interventions alarm here. */
  alertTopic: sns.ITopic;
}

export class FinGuardrail extends Construct {
  readonly guardrailId: string;
  readonly guardrailArn: string;
  readonly version: string;

  constructor(scope: Construct, id: string, props: FinGuardrailProps) {
    super(scope, id);

    const filter = (
      type: string,
      inputStrength: string,
      outputStrength: string,
    ): bedrock.CfnGuardrail.ContentFilterConfigProperty => ({ type, inputStrength, outputStrength });

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: props.name,
      description:
        'fin: prompt-attack screening of untrusted news, filings and web text; output content and PII filters',
      blockedInputMessaging: BLOCKED_INPUT_MESSAGE,
      blockedOutputsMessaging: BLOCKED_OUTPUT_MESSAGE,
      contentPolicyConfig: {
        filtersConfig: [
          filter('HATE', 'LOW', 'HIGH'),
          filter('INSULTS', 'LOW', 'HIGH'),
          filter('SEXUAL', 'LOW', 'HIGH'),
          filter('VIOLENCE', 'NONE', 'HIGH'),
          filter('MISCONDUCT', 'NONE', 'MEDIUM'),
          // PROMPT_ATTACK only evaluates input; its output strength must be NONE.
          filter('PROMPT_ATTACK', 'HIGH', 'NONE'),
        ],
      },
      wordPolicyConfig: { managedWordListsConfig: [{ type: 'PROFANITY' }] },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          'US_SOCIAL_SECURITY_NUMBER',
          'CREDIT_DEBIT_CARD_NUMBER',
          'EMAIL',
          'PHONE',
        ].map((type) => ({
          type,
          action: 'ANONYMIZE',
          inputEnabled: false,
          outputEnabled: true,
          outputAction: 'ANONYMIZE',
        })),
      },
    });

    // A numbered version, so a console edit to DRAFT never changes what runs.
    // CloudFormation publishes a new version only when this resource changes;
    // bump the description when the policy above changes.
    const version = new bedrock.CfnGuardrailVersion(this, 'Version', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'fin guardrail v1 policy (2026-10-02)',
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailArn = guardrail.attrGuardrailArn;
    this.version = version.attrVersion;

    // Interventions, from AWS/Bedrock/Guardrails `InvocationsIntervened`. A
    // Metrics Insights query rather than a fixed-dimension metric: the docs
    // list GuardrailArn, GuardrailVersion, Operation, GuardrailContentSource
    // and GuardrailPolicyType as dimensions, and an alarm on a plain metric
    // only matches one exact dimension set. Any intervention in an hour pages:
    // on this workload a block is either an attack or a false positive, and
    // both need a human.
    new cloudwatch.Alarm(this, 'Interventions', {
      alarmDescription:
        'The fin Bedrock guardrail intervened (prompt attack or content filter). Check the v2-decision / v2-triage audit rows and the v1 logs.',
      metric: new cloudwatch.MathExpression({
        expression: cdk.Fn.join('', [
          'SELECT SUM(InvocationsIntervened) FROM "AWS/Bedrock/Guardrails" WHERE GuardrailArn = \'',
          this.guardrailArn,
          "'",
        ]),
        usingMetrics: {},
        period: cdk.Duration.hours(1),
        label: 'Guardrail interventions',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwactions.SnsAction(props.alertTopic));
  }

  /** The two env vars every guarded caller reads. */
  env(prefix = ''): Record<string, string> {
    return {
      [`${prefix}GUARDRAIL_ID`]: this.guardrailId,
      [`${prefix}GUARDRAIL_VERSION`]: this.version,
    };
  }

  /**
   * `bedrock:ApplyGuardrail` on this guardrail only. Needed both for the
   * standalone ApplyGuardrail API and for any InvokeModel / Converse call that
   * names the guardrail (on top of the InvokeModel grant the caller has).
   */
  applyStatement(): iam.PolicyStatement {
    return new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [this.guardrailArn],
    });
  }
}
