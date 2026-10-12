// SPDX-License-Identifier: MIT-0
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * One Rust Lambda crate built with `cargo lambda`, on `provided.al2023` arm64.
 *
 * Replaces the `cargo-lambda-cdk` construct, whose published tarball bundles
 * js-toml and lodash-es versions with open advisories that npm overrides cannot
 * reach. The build command is the one that construct ran: locally when
 * `cargo lambda` is on PATH, otherwise in the cargo-lambda Docker image.
 * The crate directory name must equal its package and binary name.
 */
export interface RustFunctionProps
  extends Omit<lambda.FunctionProps, 'code' | 'handler' | 'runtime' | 'architecture'> {
  /** Directory holding the crate's Cargo.toml. */
  readonly crateDir: string;
}

let cargoLambdaOnPath: boolean | undefined;
function hasCargoLambda(): boolean {
  cargoLambdaOnPath ??= spawnSync('cargo', ['lambda', '--version']).status === 0;
  return cargoLambdaOnPath;
}

// The Docker fallback's image, pinned by tag and digest so a build cannot
// silently pick up a changed image. Bump both together.
const CARGO_LAMBDA_IMAGE =
  'ghcr.io/cargo-lambda/cargo-lambda:1.9.2@sha256:aa011e79594474d5252cd1e251c0ce21c19c6cc094fbd557857855fd6bd018e0';

function buildArgs(bin: string, outDir: string): string[] {
  return ['lambda', 'build', '--lambda-dir', outDir, '--release', '--arm64', '--bin', bin, '--flatten', bin];
}

export function rustCode(crateDir: string, bin: string): lambda.Code {
  return lambda.Code.fromAsset(crateDir, {
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: cdk.DockerImage.fromRegistry(CARGO_LAMBDA_IMAGE),
      command: ['cargo', ...buildArgs(bin, cdk.AssetStaging.BUNDLING_OUTPUT_DIR)],
      local: {
        tryBundle(outputDir: string): boolean {
          if (!hasCargoLambda()) {
            process.stderr.write('cargo lambda not found on PATH; switching to Docker bundling.\n');
            return false;
          }
          const r = spawnSync('cargo', buildArgs(bin, outputDir), {
            cwd: crateDir,
            stdio: ['ignore', process.stderr, 'inherit'],
          });
          if (r.error) throw r.error;
          if (r.status !== 0) throw new Error(`cargo lambda build --bin ${bin} exited with ${r.status}`);
          return true;
        },
      },
    },
  });
}

export class RustFunction extends lambda.Function {
  constructor(scope: Construct, id: string, props: RustFunctionProps) {
    const { crateDir, ...rest } = props;
    super(scope, id, {
      ...rest,
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: 'bootstrap',
      code: rustCode(crateDir, path.basename(crateDir)),
    });
  }
}
