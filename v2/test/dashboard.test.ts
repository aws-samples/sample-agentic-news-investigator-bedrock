// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import {
  compactEvent,
  hourlyPulse,
  scoreRows,
  indexedSeries,
  dayNoonMs,
  shortModel,
} from "../src/dashboard-data.js";

describe("compactEvent", () => {
  it("flattens decisions, fills and refusals into what the page needs", () => {
    const e = compactEvent(
      {
        id: "n1",
        at: "2026-09-02T11:29:00.000Z",
        headline: "IRGC  claims\n two tankers",
        materiality: 0.62,
        touches: false,
        eventType: "political",
        trigger: "macro",
        cost: 0.65,
        turns: 17,
        model: "us.anthropic.claude-fable-5-1",
        decisions: [{ action: "buy", symbol: "wti:YES", notional_usd: 2000, confidence: 0.55, limit_price: 0.34 }],
        executions: [
          { sk: "EVT#x#execution", status: "filled", fill: { side: "buy", qty: 5882, symbol: "wti:YES", fillPrice: 0.34 } },
          { sk: "EVT#x#order-parked" },
          { sk: "EVT#x#execution", status: "dropped", reason: "dropped_stale_quote" },
        ],
      },
      false,
    );
    expect(e.headline).toBe("IRGC claims two tankers");
    expect(e.investigated).toBe(true);
    expect(e.model).toBe("fable-5-1");
    expect(e.decisions[0]).toEqual({ action: "buy", symbol: "wti:YES", notional: 2000, confidence: 0.55, watch: undefined, limit: 0.34 });
    expect(e.fills).toEqual([{ side: "buy", qty: 5882, symbol: "wti:YES", price: 0.34, deferred: false }]);
    expect(e.parked).toBe(1);
    expect(e.dropped).toEqual(["dropped_stale_quote"]);
  });

  it("keeps a budget refusal only when nothing was investigated afterwards", () => {
    const skipped = compactEvent({ id: "a", at: "2026-09-01T21:25:06.758Z", skipped: "daily budget $50 spent", executions: [] }, false);
    expect(skipped.investigated).toBe(false);
    expect(skipped.skipped).toBe("daily budget $50 spent");
    const later = compactEvent({ id: "b", at: "2026-09-01T22:00:00.000Z", skipped: "x", decisions: [{ action: "hold", confidence: 0.7 }], executions: [] }, true);
    expect(later.skipped).toBeUndefined();
    expect(later.errored).toBe(true);
  });

  it("shortens Bedrock model ids", () => {
    expect(shortModel("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("haiku-4-5-20251001");
  });
});

describe("hourlyPulse", () => {
  it("buckets by hour from the floored start and counts what happened in each", () => {
    const since = Date.parse("2026-09-02T10:30:00Z");
    const now = Date.parse("2026-09-02T13:15:00Z");
    const ev = (at: string, extra: Record<string, unknown> = {}) =>
      compactEvent({ id: at, at, materiality: 0.3, executions: [], ...extra }, false);
    const events = [
      ev("2026-09-02T10:45:00Z"),
      ev("2026-09-02T11:10:00Z", {
        decisions: [{ action: "buy", confidence: 0.5 }],
        executions: [{ sk: "x#execution", status: "filled", fill: { side: "buy", qty: 1, symbol: "S", fillPrice: 1 } }],
      }),
      ev("2026-09-02T12:59:00Z", { trigger: "position-watch", decisions: [] }),
      ev("2026-09-02T09:00:00Z"),
    ];
    const b = hourlyPulse(events, since, now);
    expect(b.map((x) => new Date(x.tMs).toISOString().slice(11, 13))).toEqual(["10", "11", "12", "13"]);
    expect(b[0].triaged).toBe(1);
    expect(b[1].investigated).toBe(1);
    expect(b[1].fills).toBe(1);
    expect(b[2].alerts).toBe(1);
    expect(b[2].investigated).toBe(1);
    expect(b.reduce((s, x) => s + x.triaged, 0)).toBe(3);
  });
});

describe("scoreRows", () => {
  it("reports holds as the declined buy, so a low positive share means vindicated holds", () => {
    const items = [
      { action: "buy", ret_1h: 0.02, ret_1d: -0.01 },
      { action: "buy", ret_1h: -0.01 },
      { action: "sell", ret_1h: 0.03 },
      { action: "hold", ret_1h: -0.02 },
      { action: "hold", ret_1h: -0.01 },
      { action: "hold", ret_1h: 0.05 },
      { action: "hold", ret_1h: null },
    ] as any;
    const rows = scoreRows(items);
    const t1h = rows.find((r) => r.group === "trades" && r.horizon === "1h")!;
    expect(t1h.n).toBe(3);
    expect(t1h.positivePct).toBeCloseTo(66.67, 1);
    expect(t1h.rightPct).toBeCloseTo(66.67, 1);
    const h1h = rows.find((r) => r.group === "holds" && r.horizon === "1h")!;
    expect(h1h.n).toBe(3);
    expect(h1h.positivePct).toBeCloseTo(33.33, 1);
    expect(h1h.rightPct).toBeCloseTo(66.67, 1);
    expect(rows.find((r) => r.group === "trades" && r.horizon === "1d")!.n).toBe(1);
    expect(rows.find((r) => r.horizon === "7d")).toBeUndefined();
  });
});

describe("indexedSeries", () => {
  it("values the seed bought at the base close, from the base date on", () => {
    const closes = [{ tMs: 1, close: 50 }, { tMs: 3, close: 110 }, { tMs: 2, close: 100 }, { tMs: 4, close: 0 }];
    expect(indexedSeries(closes, 100, 2, 100_000)).toEqual([{ tMs: 2, value: 100_000 }, { tMs: 3, value: 110_000 }]);
    expect(indexedSeries(closes, 0, 2, 100_000)).toEqual([]);
  });
});

describe("dayNoonMs", () => {
  it("is local noon of the labelled day", () => {
    const d = new Date(dayNoonMs("2026-09-01"));
    expect(d.getHours()).toBe(12);
    expect(d.getDate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Added 2026-09-10: orders, mandate, corrections, bench summaries.
import { describeOrders, mandateStatus, compactCorrections, benchRows } from "../src/dashboard-data.js";

describe("describeOrders (PENDING# rows -> working exits + parked)", () => {
  const now = Date.parse("2026-09-08T14:00:00Z");
  const base = { kind: "prediction", confidence: 0.7, news_id: "review-1", created_at: "2026-09-08T13:21:00Z", rationale: "r" };
  const working = { ...base, symbol: "tx:YES", side: "sell" as const, notional_usd: 5203.8, limit_price: 0.12, expires_at: "2026-09-09T13:21:00Z", parked_reason: "liquidity_capped", reduce_only: true, requested_usd: 5215, filled_usd: 11.2, not_before: "2026-09-08T14:21:00Z" };
  const parked = { ...base, symbol: "BZ=F", side: "buy" as const, notional_usd: 2000, limit_price: 99.5, expires_at: "2026-09-08T20:00:00Z", parked_reason: "dropped_stale_quote" };
  it("splits and sorts by expiry, and computes slice progress and timing", () => {
    const o = describeOrders([working, parked], now);
    expect(o.working.map((x) => x.symbol)).toEqual(["tx:YES"]);
    expect(o.parked.map((x) => x.symbol)).toEqual(["BZ=F"]);
    const w = o.working[0];
    expect(w.requestedUsd).toBe(5215);
    expect(w.filledUsd).toBeCloseTo(11.2);
    expect(w.progressPct).toBeCloseTo((11.2 / 5215) * 100, 6);
    expect(w.nextSliceInMs).toBe(21 * 60_000);
    expect(w.expiresInMs).toBe(Date.parse(working.expires_at) - now);
    const p = o.parked[0];
    expect(p.progressPct).toBeNull();
    expect(p.nextSliceInMs).toBeNull();
    expect(p.limitPrice).toBe(99.5);
  });
  it("a due slice reads as 0 ms, and a remainder without requested_usd infers it", () => {
    const due = { ...working, not_before: "2026-09-08T13:00:00Z", requested_usd: undefined };
    const w = describeOrders([due], now).working[0];
    expect(w.nextSliceInMs).toBe(0);
    expect(w.requestedUsd).toBeCloseTo(5203.8 + 11.2);
  });
});

describe("mandateStatus", () => {
  const m = { minDeployedPct: 0.3, maxDeployedPct: 0.7, minPositions: 4, maxPositions: 12, maxPositionPct: 0.1 };
  it("under the floor: gap is dollars to the floor", () => {
    const v = mandateStatus({ equityUsd: 100_000, deployedUsd: 20_000, deployedPct: 0.2, positions: 3 }, m, 0.05);
    expect(v.status).toBe("under");
    expect(v.gapUsd).toBeCloseTo(10_000);
    expect(v.positionsStatus).toBe("few");
  });
  it("in band and over the ceiling", () => {
    expect(mandateStatus({ equityUsd: 100_000, deployedUsd: 45_000, deployedPct: 0.45, positions: 8 }, m, 0.08)).toMatchObject({ status: "in-band", gapUsd: 0, positionsStatus: "in-band" });
    const over = mandateStatus({ equityUsd: 100_000, deployedUsd: 80_000, deployedPct: 0.8, positions: 14 }, m, 0.2);
    expect(over.status).toBe("over");
    expect(over.gapUsd).toBeCloseTo(10_000);
    expect(over.positionsStatus).toBe("many");
    expect(over.largestPositionPct).toBe(0.2);
  });
  it("unknown without an equity figure", () => {
    expect(mandateStatus({ equityUsd: null, deployedUsd: 0, deployedPct: null, positions: 0 }, m, null).status).toBe("unknown");
  });
});

describe("compactCorrections", () => {
  it("flattens every reversal on an event and sorts newest first", () => {
    const events = [
      { id: "correction-2026-09-08", at: "2026-09-08T15:23:31Z", executions: [], corrections: [
        { at: "2026-09-08T15:23:31.231Z", symbol: "tx:YES", qty: 37175, avg_cost: 0.1715, reason: "pre-cap", unrealized_removed_usd: -1170.37 },
        { at: "2026-09-08T15:23:31.382Z", symbol: "la:YES", qty: 14305, avg_cost: 0.18, reason: "pre-cap", unrealized_removed_usd: -715.25 },
      ] },
      { id: "n1", at: "2026-09-08T10:00:00Z", executions: [] },
    ];
    const c = compactCorrections(events as any);
    expect(c.map((x) => x.symbol)).toEqual(["la:YES", "tx:YES"]);
    expect(c[1].costBasis).toBeCloseTo(37175 * 0.1715);
    expect(c[0].unrealizedRemovedUsd).toBeCloseTo(-715.25);
  });
});

describe("benchRows", () => {
  it("maps BENCHSUM rows, derives name/variant from the sk, and sorts newest first", () => {
    const rows = benchRows([
      { pk: "BENCHSUM", sk: "bench-asof-w2#live", bench: "bench-asof-w2", variant: "live", window_days: 7, window: "a..b", events_seen: 40, triage_passed: 9, decided: 9, buys: 2, sells: 0, holds: 7, filled: 2, dropped: 0, errored: 0, unscoreable: 1, trade_mean_ret_1d: 0.031, trade_mean_ret_7d: null, cost_usd: 3.2, triage_threshold: 0.5, ran_at: "2026-09-05T00:54:17Z" },
      { pk: "BENCHSUM", sk: "bench-enrich#no-mandate", window_days: 7, events_seen: 100, triage_passed: 17, buys: 1, sells: 1, holds: 15, dropped: 1, cost_usd: 8, ran_at: "2026-09-05T02:00:00Z" },
    ]);
    expect(rows.map((r) => `${r.name}#${r.variant}`)).toEqual(["bench-enrich#no-mandate", "bench-asof-w2#live"]);
    expect(rows[1]).toMatchObject({ eventsSeen: 40, triagePassed: 9, decided: 9, buys: 2, holds: 7, filled: 2, unscoreable: 1, tradeMeanRet1d: 0.031, tradeMeanRet7d: null, costUsd: 3.2, threshold: 0.5, windowDays: 7 });
    expect(rows[0].threshold).toBeNull();
    expect(rows[0].name).toBe("bench-enrich"); // derived from the sk when `bench` is absent
  });
});

// ---------------------------------------------------------------------------
// Arms registry shaping and platform probes (arms.json; WP2/WP6).
import {
  armRole,
  orderArmKeys,
  defaultSupervisor,
  supervisorUnit,
  workerLogPath,
  printerProbesEnabled,
  parseLaunchdPrint,
  parseSystemctlShow,
} from "../src/dashboard-data.js";

const REG = [
  { key: "v1", kind: "pipeline" as const },
  { key: "v2", kind: "agent" as const },
  { key: "v3", kind: "agent" as const },
];

describe("arm roles and order", () => {
  it("focus = config.arm, identity = the pipeline arm, arm = every other agent", () => {
    expect(REG.map((a) => armRole(a, "v2"))).toEqual(["identity", "focus", "arm"]);
    expect(REG.map((a) => armRole(a, "v3"))).toEqual(["identity", "arm", "focus"]);
  });
  it("orders focus first, then other agents in registry order, then pipelines (today's v2, v3, v1)", () => {
    expect(orderArmKeys(REG, "v2")).toEqual(["v2", "v3", "v1"]);
    expect(orderArmKeys(REG, "v3")).toEqual(["v3", "v2", "v1"]);
    expect(orderArmKeys([...REG, { key: "v4", kind: "agent" }], "v2")).toEqual(["v2", "v3", "v4", "v1"]);
  });
});

describe("supervisor and log-path rules", () => {
  it("defaults to launchd on darwin and none elsewhere; V2_SUPERVISOR wins when valid", () => {
    expect(defaultSupervisor("darwin")).toBe("launchd");
    expect(defaultSupervisor("linux")).toBe("none");
    expect(defaultSupervisor("linux", "systemd")).toBe("systemd");
    expect(defaultSupervisor("darwin", "none")).toBe("none");
    expect(defaultSupervisor("darwin", "upstart")).toBe("launchd");
  });
  it("names units the way the private plists and the systemd templates do", () => {
    expect(supervisorUnit("launchd", "fin", "v2", "worker")).toBe("com.fin.v2-worker");
    expect(supervisorUnit("launchd", "fin", "v3", "worker")).toBe("com.fin.v3-worker");
    expect(supervisorUnit("launchd", "fin", "v2", "daily-report")).toBe("com.fin.v2-daily-report");
    expect(supervisorUnit("systemd", "fin", "v2", "worker")).toBe("fin-worker@v2.service");
    expect(supervisorUnit("systemd", "fin", "v2", "daily-report")).toBe("fin-letter.service");
    expect(supervisorUnit("none", "fin", "v2", "worker")).toBeNull();
  });
  it("worker logs: today's darwin path, a /var/log default elsewhere, and a pattern override", () => {
    expect(workerLogPath({ platform: "darwin", home: "/Users/me", prefix: "fin", key: "v2" })).toBe("/Users/me/Library/Logs/fin-v2-worker.log");
    expect(workerLogPath({ platform: "darwin", home: "/Users/me", prefix: "fin", key: "v3" })).toBe("/Users/me/Library/Logs/fin-v3-worker.log");
    expect(workerLogPath({ platform: "linux", home: "/home/me", prefix: "fin", key: "v2" })).toBe("/var/log/fin/v2-worker.log");
    expect(workerLogPath({ pattern: "/srv/<prefix>/logs/<key>.log", platform: "linux", home: "/home/me", prefix: "demo", key: "alpha" })).toBe("/srv/demo/logs/alpha.log");
    expect(workerLogPath({ pattern: "  ", platform: "linux", home: "/h", prefix: "fin", key: "v2" })).toBe("/var/log/fin/v2-worker.log");
  });
  it("probes CUPS only on darwin and only when printing is configured", () => {
    expect(printerProbesEnabled("darwin", {})).toBe(false);
    expect(printerProbesEnabled("darwin", { V2_PRINT: "1" })).toBe(true);
    expect(printerProbesEnabled("darwin", { V2_PRINTER: "Office" })).toBe(true);
    expect(printerProbesEnabled("linux", { V2_PRINT: "1", V2_PRINTER: "Office" })).toBe(false);
    expect(printerProbesEnabled("darwin", { V2_PRINT: " " })).toBe(false);
  });
});

describe("supervisor output parsers", () => {
  it("launchctl print", () => {
    const out = "com.fin.v2-worker = {\n\tactive count = 1\n\tpath = x\n\tstate = running\n\n\tprogram = node\n\tpid = 4242\n\truns = 3\n\tlast exit code = 0\n}";
    expect(parseLaunchdPrint(out)).toEqual({ state: "running", pid: 4242, lastExitCode: 0, runs: 3 });
    expect(parseLaunchdPrint("state = not running\nlast exit code = -9")).toEqual({ state: "not running", pid: null, lastExitCode: -9, runs: null });
    expect(parseLaunchdPrint("")).toEqual({ state: "unknown", pid: null, lastExitCode: null, runs: null });
  });
  it("systemctl show", () => {
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\nExecMainStatus=0\nNRestarts=2\n")).toEqual({ state: "running", pid: 77, lastExitCode: 0, runs: 2 });
    expect(parseSystemctlShow("LoadState=loaded\nActiveState=failed\nMainPID=0\nExecMainStatus=1\nNRestarts=0\n")).toEqual({ state: "failed", pid: null, lastExitCode: 1, runs: 0 });
    expect(parseSystemctlShow("LoadState=not-found\nActiveState=inactive\nMainPID=0\n").state).toBe("not loaded");
    expect(parseSystemctlShow("").state).toBe("unknown");
  });
});
