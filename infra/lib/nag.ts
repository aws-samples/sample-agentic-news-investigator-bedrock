// SPDX-License-Identifier: MIT-0
/**
 * cdk-nag (AwsSolutionsChecks) suppressions for the fin stack.
 *
 * Every suppression names the rule, the construct and the exact wildcard it
 * covers (`appliesTo`), with a one-line reason. Anything not listed here is a
 * real finding and fails `npm test`; a new wildcard in a grant shows up there.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import { IConstruct } from 'constructs';

export interface NagTargets {
  /** Every DynamoDB table (DDB3 is a warning-level rule; suppressed with a reason so synth output stays clean). */
  tables: IConstruct[];
  /** The news-bodies / transcripts bucket. */
  bucket: IConstruct;
  /** Every Lambda function whose execution role receives grants. */
  functions: lambda.Function[];
  /** The Lambda that publishes the equity metric (PutMetricData has no resource-level scope). */
  metricPublisher?: lambda.Function;
  /** The managed policy for the agent workers. */
  workerPolicy: iam.ManagedPolicy;
}

/** `Resource::<LogicalId.Arn>/suffix` is how cdk-nag renders a token ARN in a wildcard. */
const arnWildcard = (stack: cdk.Stack, c: IConstruct, suffix: string): string =>
  `Resource::<${stack.getLogicalId(c.node.defaultChild as cdk.CfnResource)}.Arn>/${suffix}`;

/**
 * Partition, region and account render either as literals or as
 * `<AWS::Partition>`-style pseudo-parameters (which contain colons), so those
 * segments are matched loosely; the service, resource type and wildcard are exact.
 */
const BEDROCK_MODEL_ARNS = {
  regex: '/^Resource::arn:.*:bedrock:\\*:.*:(foundation-model\\/anthropic\\.\\*|inference-profile\\/\\*\\.anthropic\\.\\*)$/',
};
const NOVA_SEARCH_MODEL_ARNS = {
  regex: '/^Resource::arn:.*:bedrock:\\*:.*:(foundation-model|inference-profile)\\/(us\\.)?amazon\\.nova-2-lite-v1:0$/',
};
const EVENTBRIDGE_REPLAYS = { regex: '/^Resource::arn:.*:events:.*:replay\\/\\*$/' };
const LAMBDA_BASIC_EXECUTION = {
  regex: '/^Policy::arn:.*:iam::aws:policy\\/service-role\\/AWSLambdaBasicExecutionRole$/',
};
/** Construct id of CDK's singleton LogRetention provider (fixed by aws-cdk-lib). */
const LOG_RETENTION_PROVIDER_ID = 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a';
/** CDK's grantRead / grantWrite / grantReadWrite action groups. */
const S3_GRANT_ACTIONS = [
  'Action::s3:GetObject*',
  'Action::s3:GetBucket*',
  'Action::s3:List*',
  'Action::s3:DeleteObject*',
  'Action::s3:Abort*',
];

export function applyNagSuppressions(stack: cdk.Stack, t: NagTargets): void {
  const tableIndexes = t.tables.map((table) => arnWildcard(stack, table, 'index/*'));
  const bucketObjects = arnWildcard(stack, t.bucket, '*');

  NagSuppressions.addResourceSuppressions(t.bucket, [
    {
      id: 'AwsSolutions-S1',
      reason:
        'Holds public feed text and agent transcripts that expire after 30 days; server access logging would add a second bucket for no security gain.',
    },
  ]);

  for (const fn of t.functions) {
    if (!fn.role) continue;
    NagSuppressions.addResourceSuppressions(
      fn.role,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is the CDK-standard CloudWatch Logs write policy for Lambda.',
          appliesTo: [LAMBDA_BASIC_EXECUTION],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'DynamoDB grants cover one table and its gsi1 index.',
          appliesTo: tableIndexes,
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Object-level access to the single news-bodies bucket, using the CDK grant action groups.',
          appliesTo: [...S3_GRANT_ACTIONS, bucketObjects],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Anthropic models across the cross-region inference profile destinations; the model ids are runtime configuration.',
          appliesTo: [BEDROCK_MODEL_ARNS],
        },
        ...(fn === t.metricPublisher
          ? [
              {
                id: 'AwsSolutions-IAM5',
                reason:
                  'cloudwatch:PutMetricData supports no resource-level permissions; the statement is scoped by a cloudwatch:namespace condition.',
                appliesTo: ['Resource::*'],
              },
            ]
          : []),
      ],
      true,
    );
  }

  // CDK's LogRetention provider (one singleton Lambda per stack) sets retention on
  // the /aws/lambda/<fn> groups Lambda creates. Its role is CDK-managed.
  const logRetentionProvider = stack.node.tryFindChild(LOG_RETENTION_PROVIDER_ID);
  if (logRetentionProvider) {
    NagSuppressions.addResourceSuppressions(
      logRetentionProvider,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: "AWSLambdaBasicExecutionRole on CDK's LogRetention provider, for its own CloudWatch Logs.",
          appliesTo: [LAMBDA_BASIC_EXECUTION],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            "CDK's LogRetention provider sets retention on log groups whose names Lambda generates at deploy time; the actions are logs:PutRetentionPolicy and logs:DeleteRetentionPolicy only.",
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );
  }

  NagSuppressions.addResourceSuppressions(t.workerPolicy, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'DynamoDB grants cover each arm table, the core table and the quote tape with their gsi1 indexes.',
      appliesTo: tableIndexes,
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Object-level access to the single transcripts bucket, using the CDK grant action groups.',
      appliesTo: [...S3_GRANT_ACTIONS, bucketObjects],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'Anthropic models across the cross-region inference profile destinations; the model ids are runtime configuration.',
      appliesTo: [BEDROCK_MODEL_ARNS],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Nova 2 Lite (web search) in every destination region of its cross-region inference profile; the model id itself is exact.',
      appliesTo: [NOVA_SEARCH_MODEL_ARNS],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'EventBridge generates a new replay id for every bench run; the replay itself is filtered to the disabled replay rule.',
      appliesTo: [EVENTBRIDGE_REPLAYS],
    },
  ]);
}
