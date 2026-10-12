// SPDX-License-Identifier: MIT-0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * The arms registry: which paper-trading arms share the news stream, and how
 * every AWS resource name derives from `prefix` + arm key. `arms.json` at the
 * repo root is the source of truth; the same file drives the CDK stack
 * (infra/lib/names.ts must agree with `armResources` — test/arms.test.ts pins
 * the derived names to the literals the private stack was built with).
 *
 * Pure module: no AWS clients, no process side effects beyond reading the file
 * once. config.ts spreads `resolveArmDefaults()` so that every arm-specific
 * default (table, params, model, effort, world model, caps) comes from here and
 * an explicit V2_* env variable always wins.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export type ArmKind = "agent" | "pipeline";

const NAME = /^[a-z][a-z0-9-]*$/;

export const ArmSchema = z
  .object({
    key: z.string().regex(NAME, "arm key: lowercase letters, digits and dashes, starting with a letter"),
    kind: z.enum(["agent", "pipeline"]),
    label: z.string().min(1),
    model: z.string().min(1),
    /** Agent arms: Agent SDK reasoning effort; null = the SDK default (high). */
    effort: z.enum(EFFORTS).nullable().default(null),
    /** Agent arms: typed, gated shared world model + curiosity loop. */
    worldModel: z.boolean().default(false),
    /** Initial SSM daily budget; null for a pipeline arm (no metered LLM budget). */
    dailyBudgetUsd: z.number().min(0).nullable().default(null),
    maxInvestigationsPerDay: z.number().int().positive().optional(),
  })
  .strict();

export const ArmsRegistrySchema = z
  .object({
    $schema: z.string().optional(),
    prefix: z.string().regex(NAME, "prefix: lowercase letters, digits and dashes, starting with a letter"),
    arms: z.array(ArmSchema).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    const seen = new Set<string>();
    for (const a of r.arms) {
      if (seen.has(a.key)) ctx.addIssue({ code: "custom", message: `duplicate arm key "${a.key}"`, path: ["arms"] });
      seen.add(a.key);
    }
  });

export type Arm = z.infer<typeof ArmSchema>;
export type ArmsRegistry = z.infer<typeof ArmsRegistrySchema>;

/** The investigator's master model when an arm (or a synthesized one) does not name one. */
export const DEFAULT_AGENT_MODEL = "us.anthropic.claude-fable-5-1";
/** Today's code default for the per-day investigation cap when the arm sets none. */
const DEFAULT_MAX_INVESTIGATIONS_PER_DAY = 20;

/**
 * Built-in registry, equal to the shipped arms.json: the reference experiment
 * (v1 risk-gated pipeline, v2 investigator, v3 investigator + world model).
 * Used only when no arms.json can be found next to the repo and no
 * V2_ARMS_FILE is set, so a bare checkout of v2/ still runs.
 */
export const DEFAULT_REGISTRY: ArmsRegistry = ArmsRegistrySchema.parse({
  prefix: "fin",
  arms: [
    { key: "v1", kind: "pipeline", label: "v1 reference arm", model: "us.anthropic.claude-sonnet-4-6", dailyBudgetUsd: null },
    {
      key: "v2",
      kind: "agent",
      label: "v2 investigator",
      model: DEFAULT_AGENT_MODEL,
      effort: null,
      worldModel: false,
      dailyBudgetUsd: 100,
      maxInvestigationsPerDay: 200,
    },
    {
      key: "v3",
      kind: "agent",
      label: "v3 world model",
      model: DEFAULT_AGENT_MODEL,
      effort: null,
      worldModel: true,
      dailyBudgetUsd: 100,
      maxInvestigationsPerDay: 200,
    },
  ],
});

/** Validate a parsed JSON document; the error names the file and every offending path. */
export function parseArms(doc: unknown, source = "arms.json"): ArmsRegistry {
  const r = ArmsRegistrySchema.safeParse(doc);
  if (r.success) return r.data;
  const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`);
  throw new Error(`${source} is not a valid arms registry:\n${lines.join("\n")}`);
}

/** `<repo root>/arms.json`, resolved relative to this module (v2/src or v2/dist). */
export function defaultArmsPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "arms.json");
}

const cache = new Map<string, ArmsRegistry>();

/**
 * Load the registry: an explicit `file`, else `V2_ARMS_FILE`, else the repo's
 * arms.json, else the built-in default. An explicitly named file must exist;
 * the repo default may be absent. Memoized per path.
 */
export function loadArms(file?: string): ArmsRegistry {
  const explicit = file ?? process.env.V2_ARMS_FILE;
  const target = explicit ?? defaultArmsPath();
  const hit = cache.get(target);
  if (hit) return hit;
  let reg: ArmsRegistry;
  if (!explicit && !fs.existsSync(target)) {
    reg = DEFAULT_REGISTRY;
  } else {
    let raw: string;
    try {
      raw = fs.readFileSync(target, "utf8");
    } catch (e) {
      throw new Error(`arms registry ${target} cannot be read: ${(e as Error).message}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw new Error(`arms registry ${target} is not JSON: ${(e as Error).message}`);
    }
    reg = parseArms(doc, target);
  }
  cache.set(target, reg);
  return reg;
}

/** Drop the memoized registries (tests that swap V2_ARMS_FILE). */
export function resetArmsCache(): void {
  cache.clear();
}

export function findArm(key: string, registry: ArmsRegistry = loadArms()): Arm | undefined {
  return registry.arms.find((a) => a.key === key);
}

export function armByKey(key: string, registry: ArmsRegistry = loadArms()): Arm {
  const arm = findArm(key, registry);
  if (!arm) throw new Error(`unknown arm "${key}" (arms.json has: ${registry.arms.map((a) => a.key).join(", ")})`);
  return arm;
}

/** The arm a process is when V2_ARM is unset: the first agent arm (v2 in the shipped file). */
export function defaultArmKey(registry: ArmsRegistry = loadArms()): string {
  return (registry.arms.find((a) => a.kind === "agent") ?? registry.arms[0]).key;
}

export interface ArmResources {
  table: string;
  /** null for a pipeline arm: it consumes the bus directly, not through a queue. */
  newsQueue: string | null;
  dlq: string | null;
  killSwitchParam: string;
  /** null for a pipeline arm: no metered LLM budget. */
  budgetParam: string | null;
  tapeTable: string;
  bus: string;
}

/**
 * Every resource name an arm owns, from prefix + key. With prefix `fin` these
 * are exactly the names the private stack was built with (fin-v2-trading,
 * fin-v3-news, /fin/v3/kill-switch, fin-quote-tape, fin-events …). The
 * pipeline arm predates the per-arm scheme and keeps `<prefix>-trading` and
 * `/<prefix>/kill-switch`. Mirror any change in infra/lib/names.ts.
 */
export function armResources(prefix: string, key: string, kind: ArmKind = "agent"): ArmResources {
  const shared = { tapeTable: `${prefix}-quote-tape`, bus: `${prefix}-events` };
  if (kind === "pipeline") {
    return { table: `${prefix}-trading`, newsQueue: null, dlq: null, killSwitchParam: `/${prefix}/kill-switch`, budgetParam: null, ...shared };
  }
  return {
    table: `${prefix}-${key}-trading`,
    newsQueue: `${prefix}-${key}-news`,
    dlq: `${prefix}-${key}-news-dlq`,
    killSwitchParam: `/${prefix}/${key}/kill-switch`,
    budgetParam: `/${prefix}/${key}/daily-budget-usd`,
    ...shared,
  };
}

export function resourcesOf(arm: Arm, registry: ArmsRegistry = loadArms()): ArmResources {
  return armResources(registry.prefix, arm.key, arm.kind);
}

/**
 * The table to read an arm from: the focus arm's table is whatever this
 * process was configured with (V2_TABLE may override it); every other arm's
 * comes from the registry.
 */
export function tableFor(arm: Arm, registry: ArmsRegistry, focus: { key: string; table: string }): string {
  return arm.key === focus.key ? focus.table : resourcesOf(arm, registry).table;
}

export interface ArmDefaults {
  arm: string;
  kind: ArmKind;
  label: string;
  table: string;
  tapeTable: string;
  newsQueue: string | null;
  killSwitchParam: string;
  dailyBudgetParam: string;
  masterModel: string;
  effort: Effort | undefined;
  worldModel: boolean;
  maxInvestigationsPerDay: number;
  dailyBudgetUsd: number | null;
  /** Only ever from V2_INCEPTION; the stored value is STATE/INCEPTION in the arm's table. */
  inceptionIso: string | undefined;
}

type Env = Record<string, string | undefined>;

/**
 * Pure precedence rule: an explicit V2_* variable wins, else the arm's entry,
 * else the code default. `V2_ARM` selects the arm (default: the first agent
 * arm). An unknown key is tolerated — names derive from prefix + key and the
 * code defaults apply — so a new arm can be brought up env-first; a pipeline
 * arm cannot be the focus of this codebase's processes (its table belongs to
 * the Rust chain) and is refused.
 */
export function resolveArmDefaults(env: Env, registry: ArmsRegistry = loadArms()): ArmDefaults {
  const key = env.V2_ARM ?? defaultArmKey(registry);
  const found = findArm(key, registry);
  if (found?.kind === "pipeline") {
    throw new Error(`V2_ARM=${key} names a pipeline arm; the worker, report, dashboard and letter must focus an agent arm`);
  }
  const arm: Arm =
    found ?? {
      key,
      kind: "agent",
      label: `${key} investigator`,
      model: DEFAULT_AGENT_MODEL,
      effort: null,
      worldModel: false,
      dailyBudgetUsd: null,
    };
  const res = armResources(registry.prefix, arm.key, "agent");
  const envEffort = env.V2_EFFORT || undefined;
  return {
    arm: arm.key,
    kind: arm.kind,
    label: arm.label,
    table: env.V2_TABLE ?? res.table,
    tapeTable: env.V2_TAPE_TABLE ?? res.tapeTable,
    newsQueue: res.newsQueue,
    killSwitchParam: env.V2_KILL_SWITCH_PARAM ?? res.killSwitchParam,
    dailyBudgetParam: env.V2_DAILY_BUDGET_PARAM ?? res.budgetParam!,
    masterModel: env.V2_MASTER_MODEL ?? arm.model,
    effort: (envEffort as Effort | undefined) ?? arm.effort ?? undefined,
    worldModel: env.V2_WORLD_MODEL !== undefined ? env.V2_WORLD_MODEL.toLowerCase() === "1" : arm.worldModel,
    maxInvestigationsPerDay: Number(
      env.V2_MAX_INVESTIGATIONS_PER_DAY ?? arm.maxInvestigationsPerDay ?? DEFAULT_MAX_INVESTIGATIONS_PER_DAY,
    ),
    dailyBudgetUsd: arm.dailyBudgetUsd,
    inceptionIso: env.V2_INCEPTION || undefined,
  };
}
