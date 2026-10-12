// SPDX-License-Identifier: MIT-0
/**
 * Resource naming for the fin stack.
 *
 * Every physical name is a pure function of a deployment `prefix` (default
 * "fin") and, for per-arm resources, the arm's `key`. With prefix "fin" and
 * arms "v2" / "v3" the derived names equal the literals the stack carried
 * before it was parameterised (asserted in test/names.test.ts), so an
 * existing deployment keeps its tables, queues and parameters.
 *
 * The runtime package derives the same names from the same arms file; keep
 * this module dependency-free so it can be shared as a parity fixture.
 */

export type ArmKind = 'agent' | 'pipeline';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One arm of the experiment: a table, a queue, a budget, a kill switch and an env block. */
export interface ArmDescriptor {
  /** Short id used in resource names and SSM paths (`/^[a-z][a-z0-9-]{0,15}$/`). */
  key: string;
  /**
   * `agent`: an investigator worker fed by its own SQS queue, trading into its
   * own table under its own budget and kill switch.
   * `pipeline`: the risk-gated Lambda pipeline. At most one; it owns the core
   * table (`<prefix>-trading`) and the core kill switch (`/<prefix>/kill-switch`).
   */
  kind: ArmKind;
  /** Human-readable name for reports and dashboards. */
  label: string;
  /** Bedrock model id: the master model of an agent arm, the analysis model of the pipeline. */
  model: string;
  /** Reasoning effort for agent arms; unset means the SDK default. */
  effort?: Effort;
  /** Agent arms only: enable the gated world model and the curiosity loop. */
  worldModel: boolean;
  /** Initial value of the arm's daily LLM spend ceiling parameter (USD). Informational for the pipeline. */
  /** Initial value of the SSM daily budget; null = no metered budget (the pipeline arm). */
  dailyBudgetUsd: number | null;
  /** Per-day investigation cap handed to the worker's env. Informational for the pipeline. */
  maxInvestigationsPerDay?: number;
}

export const DEFAULT_PREFIX = 'fin';

const PREFIX_RE = /^[a-z][a-z0-9-]{0,15}$/;
const KEY_RE = /^[a-z][a-z0-9-]{0,15}$/;

export function assertPrefix(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(
      `prefix "${prefix}" must match ${PREFIX_RE} (it is embedded in table, queue, bus and SSM names)`,
    );
  }
  return prefix;
}

export function assertArmKey(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new Error(`arm key "${key}" must match ${KEY_RE} (it is embedded in table, queue and SSM names)`);
  }
  return key;
}

// ---------- Shared plumbing ----------

export const busName = (prefix: string): string => `${prefix}-events`;
export const busArchiveName = (prefix: string): string => `${prefix}-events-archive`;
/** The core table: the pipeline arm's ledger and every poller's dedupe store. */
export const coreTableName = (prefix: string): string => `${prefix}-trading`;
/** The pipeline arm's kill switch (read by the risk gate). */
export const coreKillSwitchParam = (prefix: string): string => `/${prefix}/kill-switch`;
export const alertTopicName = (prefix: string): string => `${prefix}-alerts`;
export const dashboardName = (prefix: string): string => `${prefix}-trading`;
/** Every price either arm observes, stamped when observed; shared by all agent arms. */
export const tapeTableName = (prefix: string): string => `${prefix}-quote-tape`;
/** The replay bench's queue, DLQ and normally-disabled rule; shared by all arms. */
export const replayQueueName = (prefix: string): string => `${prefix}-replay`;
export const replayDlqName = (prefix: string): string => `${prefix}-replay-dlq`;
export const replayRuleName = (prefix: string): string => `${prefix}-replay-rule`;
/** Where every Lambda's failed asynchronous invocations land. */
export const functionDlqName = (prefix: string): string => `${prefix}-lambda-dlq`;
/** Managed policy an operator attaches to whatever principal runs the agent workers. */
export const workerPolicyName = (prefix: string): string => `${prefix}-worker`;

// ---------- Per arm ----------

export type ArmRef = Pick<ArmDescriptor, 'key' | 'kind'>;

/** The pipeline arm trades in the core table; agent arms each get their own. */
export function armTableName(prefix: string, arm: ArmRef): string {
  return arm.kind === 'pipeline' ? coreTableName(prefix) : `${prefix}-${arm.key}-trading`;
}
export const armNewsQueueName = (prefix: string, key: string): string => `${prefix}-${key}-news`;
export const armNewsDlqName = (prefix: string, key: string): string => `${prefix}-${key}-news-dlq`;
export function armKillSwitchParam(prefix: string, arm: ArmRef): string {
  return arm.kind === 'pipeline' ? coreKillSwitchParam(prefix) : `/${prefix}/${arm.key}/kill-switch`;
}
export const armDailyBudgetParam = (prefix: string, key: string): string =>
  `/${prefix}/${key}/daily-budget-usd`;

/** Everything a worker needs to know about its arm, by name. */
export interface ArmResources {
  table: string;
  killSwitchParam: string;
  /** Agent arms only. */
  newsQueue?: string;
  newsDlq?: string;
  dailyBudgetParam?: string;
}

export function armResources(prefix: string, arm: ArmRef): ArmResources {
  const base: ArmResources = {
    table: armTableName(prefix, arm),
    killSwitchParam: armKillSwitchParam(prefix, arm),
  };
  if (arm.kind === 'pipeline') return base;
  return {
    ...base,
    newsQueue: armNewsQueueName(prefix, arm.key),
    newsDlq: armNewsDlqName(prefix, arm.key),
    dailyBudgetParam: armDailyBudgetParam(prefix, arm.key),
  };
}

// ---------- Construct ids ----------
//
// CloudFormation logical ids derive from construct ids, so these are part of
// the deployed contract: "v2" -> "V2Table", "V2NewsQueue", ... exactly as the
// hand-written stack named them. Never change the scheme for an existing arm.

export function armConstructPrefix(key: string): string {
  return key
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export const armConstructId = (key: string, suffix: string): string =>
  `${armConstructPrefix(key)}${suffix}`;
