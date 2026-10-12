#!/usr/bin/env node
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FinStack } from '../lib/fin-stack';

const app = new cdk.App();

// FIN_SKIP_BUNDLING=1 skips the `cargo lambda build` asset bundling so the
// template can be synthesised, linted and diffed without a Rust toolchain
// (CI, cdk-nag checks). Set on the node after construction because the CLI's
// own bundling-stacks context would otherwise win. Never deploy from a
// skipped-bundling synth: the Lambda code assets are placeholders.
if (process.env.FIN_SKIP_BUNDLING === '1') {
  app.node.setContext('aws:cdk:bundling-stacks', []);
}

// Stack name: FIN_STACK_NAME, then context `stackName`, then "FinStack".
// Account and region come from the CDK CLI's resolved credentials
// (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION), i.e. the active profile.
const stackName =
  process.env.FIN_STACK_NAME ?? (app.node.tryGetContext('stackName') as string | undefined) ?? 'FinStack';

new FinStack(app, stackName, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// AWS Solutions rules; justified suppressions live in lib/nag.ts.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
