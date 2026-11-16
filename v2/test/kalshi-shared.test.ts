// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { mkdtempSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachePath, readShared, writeShared, tryLock, unlock, type KalshiHit } from "../src/quotes/kalshi-search.js";

const hit: KalshiHit = { symbol: "KXHURCAT-26VANCE-T4:YES", title: "Hurricane Vance category? — 4", event: "KXHURCAT-26VANCE", category: "Climate and Weather", yesBid: 0.1, yesAsk: 0.12, volume24h: 100, closes: "2026-12-02T04:59:00Z" };

describe("one Kalshi index shared by every worker on the host", () => {
  it("lives under HOME by default, can be pointed elsewhere, and can be turned off", () => {
    expect(cachePath({ HOME: "/opt/fin" })).toBe("/opt/fin/.cache/fin/kalshi-index.json");
    expect(cachePath({ HOME: "/opt/fin", V2_KALSHI_CACHE: "/var/cache/k.json" })).toBe("/var/cache/k.json");
    expect(cachePath({ V2_KALSHI_CACHE: "off" })).toBeNull();
  });

  it("round-trips through an atomic write; a missing, empty or corrupt file reads as nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalshi-"));
    const p = join(dir, "sub", "index.json");
    expect(readShared(p)).toBeNull();
    writeShared(p, { builtAt: 1234, hits: [hit] });
    expect(readShared(p)).toEqual({ builtAt: 1234, hits: [hit] });
    writeShared(p, { builtAt: 1, hits: [] });
    expect(readShared(p)).toBeNull();
    expect(existsSync(`${p}.${process.pid}.tmp`)).toBe(false);
  });

  it("only one process holds the rebuild lock; a dead builder's lock is taken over after 5 minutes", () => {
    const dir = mkdtempSync(join(tmpdir(), "kalshi-"));
    const lock = join(dir, "index.json.lock");
    expect(tryLock(lock)).toBe(true);
    expect(tryLock(lock)).toBe(false); // the second worker
    const old = (Date.now() - 6 * 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(tryLock(lock)).toBe(true); // stale: taken over
    unlock(lock);
    expect(existsSync(lock)).toBe(false);
    expect(tryLock(lock)).toBe(true);
  });
});
