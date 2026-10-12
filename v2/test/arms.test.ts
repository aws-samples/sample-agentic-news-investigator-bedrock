// SPDX-License-Identifier: MIT-0
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadArms,
  parseArms,
  armResources,
  resourcesOf,
  resolveArmDefaults,
  defaultArmKey,
  armByKey,
  findArm,
  tableFor,
  defaultArmsPath,
  resetArmsCache,
  DEFAULT_REGISTRY,
  type ArmsRegistry,
} from "../src/arms.js";
import { seedItems, parseArgs } from "../src/seed.js";

/**
 * The arms registry is the one place resource names and per-arm defaults come
 * from. These tests pin (1) the derived names to the literals the private stack
 * was built with, so nothing moves for fin/v1/v2/v3, (2) the precedence rule —
 * an explicit V2_* variable always wins — and (3) that the shipped arms.json is
 * the running experiment.
 */

const shippedPath = defaultArmsPath();

describe("arms.json (shipped)", () => {
  it("lives at the repo root, validates, and equals the built-in default", () => {
    expect(fs.existsSync(shippedPath)).toBe(true);
    const reg = loadArms(shippedPath);
    expect({ prefix: reg.prefix, arms: reg.arms }).toEqual({ prefix: DEFAULT_REGISTRY.prefix, arms: DEFAULT_REGISTRY.arms });
    expect(reg.arms.map((a) => a.key)).toEqual(["v1", "v2", "v3"]);
  });

  it("is the running experiment: models, budgets, caps, world model", () => {
    const reg = loadArms(shippedPath);
    const v1 = armByKey("v1", reg);
    const v2 = armByKey("v2", reg);
    const v3 = armByKey("v3", reg);
    expect(v1.kind).toBe("pipeline");
    expect(v1.model).toBe("us.anthropic.claude-sonnet-4-6");
    expect(v1.dailyBudgetUsd).toBeNull();
    for (const a of [v2, v3]) {
      expect(a.kind).toBe("agent");
      expect(a.model).toBe("us.anthropic.claude-fable-5-1");
      expect(a.effort).toBeNull();
      expect(a.dailyBudgetUsd).toBe(100);
      expect(a.maxInvestigationsPerDay).toBe(200);
    }
    expect(v2.worldModel).toBe(false);
    expect(v3.worldModel).toBe(true);
  });

  it("agrees with arms.schema.json on required keys and enums", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(path.dirname(shippedPath), "arms.schema.json"), "utf8"));
    const doc = JSON.parse(fs.readFileSync(shippedPath, "utf8"));
    expect(schema.$schema).toContain("draft-07");
    for (const k of schema.required) expect(doc).toHaveProperty(k);
    const armSchema = schema.definitions.arm;
    for (const arm of doc.arms) {
      for (const k of armSchema.required) expect(arm).toHaveProperty(k);
      expect(armSchema.properties.kind.enum).toContain(arm.kind);
      for (const k of Object.keys(arm)) expect(armSchema.properties).toHaveProperty(k); // additionalProperties: false
    }
  });
});

describe("parseArms validation", () => {
  const base = { prefix: "fin", arms: [{ key: "a", kind: "agent", label: "A", model: "m" }] };
  it("accepts a minimal registry and fills defaults", () => {
    const r = parseArms(base);
    expect(r.arms[0]).toEqual({ key: "a", kind: "agent", label: "A", model: "m", effort: null, worldModel: false, dailyBudgetUsd: null });
  });
  it("rejects duplicate keys", () => {
    expect(() => parseArms({ ...base, arms: [base.arms[0], base.arms[0]] }, "x.json")).toThrow(/x\.json.*duplicate arm key "a"/s);
  });
  it("rejects a bad kind, a bad key, an unknown field, an empty list and a bad prefix", () => {
    expect(() => parseArms({ ...base, arms: [{ ...base.arms[0], kind: "robot" }] })).toThrow(/kind/);
    expect(() => parseArms({ ...base, arms: [{ ...base.arms[0], key: "V 2" }] })).toThrow(/key/);
    expect(() => parseArms({ ...base, arms: [{ ...base.arms[0], colour: "red" }] })).toThrow(/colour|unrecognized/i);
    expect(() => parseArms({ ...base, arms: [] })).toThrow(/arms/);
    expect(() => parseArms({ ...base, prefix: "Fin_" })).toThrow(/prefix/);
  });
  it("rejects a non-listed effort and a negative budget", () => {
    expect(() => parseArms({ ...base, arms: [{ ...base.arms[0], effort: "ultra" }] })).toThrow(/effort/);
    expect(() => parseArms({ ...base, arms: [{ ...base.arms[0], dailyBudgetUsd: -1 }] })).toThrow(/dailyBudgetUsd/);
  });
});

describe("armResources: derived names equal today's literals", () => {
  it("agent arms v2 / v3 with prefix fin", () => {
    expect(armResources("fin", "v2")).toEqual({
      table: "fin-v2-trading",
      newsQueue: "fin-v2-news",
      dlq: "fin-v2-news-dlq",
      killSwitchParam: "/fin/v2/kill-switch",
      budgetParam: "/fin/v2/daily-budget-usd",
      tapeTable: "fin-quote-tape",
      bus: "fin-events",
    });
    expect(armResources("fin", "v3", "agent")).toMatchObject({
      table: "fin-v3-trading",
      newsQueue: "fin-v3-news",
      dlq: "fin-v3-news-dlq",
      killSwitchParam: "/fin/v3/kill-switch",
      budgetParam: "/fin/v3/daily-budget-usd",
    });
  });
  it("the pipeline arm keeps <prefix>-trading and /<prefix>/kill-switch, with no queue or budget", () => {
    expect(armResources("fin", "v1", "pipeline")).toEqual({
      table: "fin-trading",
      newsQueue: null,
      dlq: null,
      killSwitchParam: "/fin/kill-switch",
      budgetParam: null,
      tapeTable: "fin-quote-tape",
      bus: "fin-events",
    });
  });
  it("another prefix moves everything together", () => {
    expect(armResources("demo", "alpha")).toMatchObject({ table: "demo-alpha-trading", newsQueue: "demo-alpha-news", killSwitchParam: "/demo/alpha/kill-switch", tapeTable: "demo-quote-tape", bus: "demo-events" });
    expect(armResources("demo", "ref", "pipeline").table).toBe("demo-trading");
  });
  it("resourcesOf and tableFor read the registry; the focus arm keeps its configured table", () => {
    const reg = loadArms(shippedPath);
    expect(resourcesOf(armByKey("v1", reg), reg).table).toBe("fin-trading");
    expect(resourcesOf(armByKey("v3", reg), reg).newsQueue).toBe("fin-v3-news");
    const focus = { key: "v2", table: "fin-v2-trading-copy" };
    expect(tableFor(armByKey("v2", reg), reg, focus)).toBe("fin-v2-trading-copy");
    expect(tableFor(armByKey("v3", reg), reg, focus)).toBe("fin-v3-trading");
    expect(tableFor(armByKey("v1", reg), reg, focus)).toBe("fin-trading");
  });
});

describe("registry lookups", () => {
  const reg = loadArms(shippedPath);
  it("defaultArmKey is the first agent arm", () => {
    expect(defaultArmKey(reg)).toBe("v2");
    expect(defaultArmKey(parseArms({ prefix: "p", arms: [{ key: "only", kind: "pipeline", label: "x", model: "m" }] }))).toBe("only");
  });
  it("armByKey names the known keys when it fails; findArm is quiet", () => {
    expect(() => armByKey("v9", reg)).toThrow(/unknown arm "v9".*v1, v2, v3/);
    expect(findArm("v9", reg)).toBeUndefined();
  });
});

describe("resolveArmDefaults: env always wins, else the arm, else the code default", () => {
  const reg = loadArms(shippedPath);

  it("no env → the v2 arm's registry values, which equal today's config.ts defaults", () => {
    const d = resolveArmDefaults({}, reg);
    expect(d).toEqual({
      arm: "v2",
      kind: "agent",
      label: "v2 investigator",
      table: "fin-v2-trading",
      tapeTable: "fin-quote-tape",
      newsQueue: "fin-v2-news",
      killSwitchParam: "/fin/v2/kill-switch",
      dailyBudgetParam: "/fin/v2/daily-budget-usd",
      masterModel: "us.anthropic.claude-fable-5-1",
      effort: undefined,
      worldModel: false,
      maxInvestigationsPerDay: 200,
      dailyBudgetUsd: 100,
      inceptionIso: undefined,
    });
  });

  it("V2_ARM=v3 alone yields exactly what the v3 worker's env block spells out today", () => {
    const fromRegistry = resolveArmDefaults({ V2_ARM: "v3" }, reg);
    // The private v3 plist, minus operator specifics (profile, contact, bucket, queue URL).
    const plistEnv = {
      V2_ARM: "v3",
      V2_DAILY_BUDGET_PARAM: "/fin/v3/daily-budget-usd",
      V2_KILL_SWITCH_PARAM: "/fin/v3/kill-switch",
      V2_MAX_INVESTIGATIONS_PER_DAY: "200",
      V2_TABLE: "fin-v3-trading",
      V2_WORLD_MODEL: "1",
    };
    const fromEnv = resolveArmDefaults(plistEnv, reg);
    expect(fromRegistry).toEqual(fromEnv);
    expect(fromRegistry).toMatchObject({ arm: "v3", table: "fin-v3-trading", worldModel: true, killSwitchParam: "/fin/v3/kill-switch", newsQueue: "fin-v3-news" });
  });

  it("every V2_* override beats the arm entry", () => {
    const d = resolveArmDefaults(
      {
        V2_ARM: "v3",
        V2_TABLE: "t",
        V2_TAPE_TABLE: "tape",
        V2_KILL_SWITCH_PARAM: "/k",
        V2_DAILY_BUDGET_PARAM: "/b",
        V2_MASTER_MODEL: "m",
        V2_EFFORT: "low",
        V2_WORLD_MODEL: "0",
        V2_MAX_INVESTIGATIONS_PER_DAY: "7",
        V2_INCEPTION: "2026-01-01T00:00:00Z",
      },
      reg,
    );
    expect(d).toMatchObject({
      arm: "v3",
      table: "t",
      tapeTable: "tape",
      killSwitchParam: "/k",
      dailyBudgetParam: "/b",
      masterModel: "m",
      effort: "low",
      worldModel: false,
      maxInvestigationsPerDay: 7,
      inceptionIso: "2026-01-01T00:00:00Z",
    });
  });

  it("an empty V2_EFFORT or V2_INCEPTION reads as unset; the arm's effort applies when set", () => {
    expect(resolveArmDefaults({ V2_EFFORT: "", V2_INCEPTION: "" }, reg)).toMatchObject({ effort: undefined, inceptionIso: undefined });
    const custom = parseArms({ prefix: "fin", arms: [{ key: "z", kind: "agent", label: "Z", model: "m", effort: "xhigh", maxInvestigationsPerDay: 5 }] });
    expect(resolveArmDefaults({}, custom)).toMatchObject({ arm: "z", effort: "xhigh", maxInvestigationsPerDay: 5, masterModel: "m" });
    expect(resolveArmDefaults({ V2_EFFORT: "medium" }, custom).effort).toBe("medium");
  });

  it("an arm missing from the registry is synthesized from prefix + key with the code defaults", () => {
    const d = resolveArmDefaults({ V2_ARM: "v4" }, reg);
    expect(d).toMatchObject({
      arm: "v4",
      label: "v4 investigator",
      table: "fin-v4-trading",
      newsQueue: "fin-v4-news",
      killSwitchParam: "/fin/v4/kill-switch",
      dailyBudgetParam: "/fin/v4/daily-budget-usd",
      masterModel: "us.anthropic.claude-fable-5-1",
      worldModel: false,
      maxInvestigationsPerDay: 20,
      dailyBudgetUsd: null,
    });
  });

  it("refuses to focus the pipeline arm (its table belongs to the Rust chain)", () => {
    expect(() => resolveArmDefaults({ V2_ARM: "v1" }, reg)).toThrow(/pipeline arm/);
  });
});

describe("loadArms file resolution", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arms-"));
  const saved = process.env.V2_ARMS_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.V2_ARMS_FILE;
    else process.env.V2_ARMS_FILE = saved;
    resetArmsCache();
  });

  it("V2_ARMS_FILE points at another registry, and the derived names follow its prefix", () => {
    const file = path.join(tmp, "arms.json");
    const doc: ArmsRegistry = parseArms({
      prefix: "demo",
      arms: [
        { key: "ref", kind: "pipeline", label: "ref", model: "m" },
        { key: "alpha", kind: "agent", label: "alpha", model: "m", worldModel: true, dailyBudgetUsd: 5, maxInvestigationsPerDay: 3 },
      ],
    });
    fs.writeFileSync(file, JSON.stringify(doc));
    process.env.V2_ARMS_FILE = file;
    resetArmsCache();
    const reg = loadArms();
    expect(reg.prefix).toBe("demo");
    expect(defaultArmKey(reg)).toBe("alpha");
    expect(resolveArmDefaults({}, reg)).toMatchObject({ arm: "alpha", table: "demo-alpha-trading", killSwitchParam: "/demo/alpha/kill-switch", tapeTable: "demo-quote-tape", worldModel: true, maxInvestigationsPerDay: 3 });
    expect(resourcesOf(armByKey("ref", reg), reg)).toMatchObject({ table: "demo-trading", killSwitchParam: "/demo/kill-switch" });
  });

  it("an explicitly named file must exist and must be JSON", () => {
    expect(() => loadArms(path.join(tmp, "missing.json"))).toThrow(/cannot be read/);
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    expect(() => loadArms(bad)).toThrow(/not JSON/);
  });

  it("memoizes per path", () => {
    expect(loadArms(shippedPath)).toBe(loadArms(shippedPath));
  });
});

describe("seed.ts (dry run by default)", () => {
  const reg = loadArms(shippedPath);
  it("plans the two guarded rows for an arm's registry table", () => {
    const items = seedItems({ arm: "v3", cash: 100_000, inceptionIso: "2026-09-03T01:39:22.123Z", dayKey: "2026-09-03" }, reg);
    expect(items).toEqual([
      { table: "fin-v3-trading", item: { pk: "PORTFOLIO", sk: "SNAPSHOT", cash: 100_000, realized_pnl_today: 0, day_key: "2026-09-03" }, condition: "attribute_not_exists(pk)" },
      { table: "fin-v3-trading", item: { pk: "STATE", sk: "INCEPTION", at: "2026-09-03T01:39:22Z" }, condition: "attribute_not_exists(pk)" },
    ]);
  });
  it("honours --table, and rejects a bad cash or inception", () => {
    expect(seedItems({ arm: "v2", cash: 1, inceptionIso: "2026-01-01T00:00:00Z", table: "x" }, reg)[0].table).toBe("x");
    expect(() => seedItems({ arm: "v2", cash: 0, inceptionIso: "2026-01-01T00:00:00Z" }, reg)).toThrow(/--cash/);
    expect(() => seedItems({ arm: "v2", cash: 1, inceptionIso: "yesterday" }, reg)).toThrow(/--inception/);
    expect(() => seedItems({ arm: "v9", cash: 1, inceptionIso: "2026-01-01T00:00:00Z" }, reg)).toThrow(/unknown arm/);
  });
  it("parseArgs: --apply is opt-in, --arm falls back to V2_ARM, and a missing arm is a usage error", () => {
    const a = parseArgs(["--arm", "v2", "--cash", "50000", "--inception", "2026-08-30T20:54:43Z"]);
    expect(a).toMatchObject({ arm: "v2", cash: 50_000, inceptionIso: "2026-08-30T20:54:43Z", apply: false, region: "us-east-1" });
    expect(parseArgs(["--cash", "1", "--apply", "--region", "eu-west-1"], { V2_ARM: "v3" })).toMatchObject({ arm: "v3", apply: true, region: "eu-west-1" });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["--arm"])).toThrow(/--arm needs a value/);
  });
});
