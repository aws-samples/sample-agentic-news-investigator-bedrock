// SPDX-License-Identifier: MIT-0
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseEnabledSources, sourcesPromptSection, sourceEnabled } from "../src/sources.js";
import { resolve } from "../src/quotes/resolver.js";
import { checkResolution, kalshiQuote, polymarketQuote, searchMarkets } from "../src/quotes/prediction.js";
import { coinbaseSpotQuote } from "../src/quotes/coinbase.js";
import { yahooBars, yahooDailyCloses, yahooEquityQuote } from "../src/quotes/yahoo.js";
import { investigatorSystem } from "../src/prompts.js";

afterEach(() => vi.unstubAllGlobals());

describe("parseEnabledSources", () => {
  it("is empty by default", () => {
    expect(parseEnabledSources(undefined).size).toBe(0);
    expect(parseEnabledSources("").size).toBe(0);
  });
  it("accepts known names, any case and spacing, and ignores unknown ones", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect([...parseEnabledSources(" Yahoo , kalshi,bogus,Polymarket,coinbase")].sort()).toEqual([
      "coinbase",
      "kalshi",
      "polymarket",
      "yahoo",
    ]);
  });
});

describe("opt-in sources are off by default", () => {
  // V2_ENABLE_SOURCES is unset under test, so both sources are disabled.
  it("starts disabled", () => {
    expect(sourceEnabled("yahoo")).toBe(false);
    expect(sourceEnabled("kalshi")).toBe(false);
    expect(sourceEnabled("coinbase")).toBe(false);
    expect(sourceEnabled("polymarket")).toBe(false);
  });

  it("makes no network call for a disabled source", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network must not be touched")));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await yahooEquityQuote("SPY")).toBeNull();
    expect(await yahooDailyCloses("SPY")).toEqual([]);
    expect(await yahooBars("SPY", { interval: "1d", startMs: 0, endMs: 86_400_000 })).toEqual([]);
    expect(await kalshiQuote("KXFED-25DEC:YES")).toBeNull();
    expect(await polymarketQuote("some-market:YES")).toBeNull();
    expect(await searchMarkets("hurricane")).toEqual([]);
    expect(await checkResolution("some-market:NO")).toEqual({ resolved: false });
    expect(await checkResolution("KXFED-25DEC:NO")).toEqual({ resolved: false });
    expect(await coinbaseSpotQuote("BTC")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tells the agent no prediction venue is enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
    const r = await resolve("some-market:YES", "prediction");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("no prediction-market source is enabled");
  });

  it("tells the agent why an equity does not resolve", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network"))));
    const r = await resolve("SPY", "equity");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("(yahoo) is not enabled");
  });
});

describe("sourcesPromptSection", () => {
  it("is empty when every source is enabled", () => {
    expect(sourcesPromptSection(() => true)).toBe("");
  });
  it("names what a disabled source removes", () => {
    const s = sourcesPromptSection(() => false);
    expect(s).toContain("Yahoo is not enabled");
    expect(s).toContain("No prediction-market source is enabled");
    expect(s).toContain("Coinbase is not enabled");
  });
  it("names the missing prediction venue when only one is enabled", () => {
    expect(sourcesPromptSection((n) => n !== "kalshi")).toContain("Kalshi is not enabled");
    expect(sourcesPromptSection((n) => n !== "polymarket")).toContain("Polymarket is not enabled");
  });
  it("reaches the investigator prompt in the default configuration", () => {
    expect(investigatorSystem({ dryRun: true })).toContain("## Price sources in this deployment");
  });
});
