// SPDX-License-Identifier: MIT-0
import { describe, it, expect } from "vitest";
import { marketSessionContext } from "../src/investigate.js";

function ctx(iso: string): string {
  return marketSessionContext(new Date(iso));
}

describe("marketSessionContext", () => {
  it("US equities closed Sunday night, FX open (the USO incident)", () => {
    const c = ctx("2026-08-31T04:34:00Z"); // Monday 04:34 UTC
    expect(c).toContain("US equities/ETFs CLOSED");
    expect(c).toContain("FX majors OPEN");
  });
  it("US equities open Monday afternoon UTC", () => {
    const c = ctx("2026-08-31T15:00:00Z");
    expect(c).toContain("US equities/ETFs OPEN");
  });
  it("everything but 24/7 venues closed Saturday", () => {
    const c = ctx("2026-08-29T12:00:00Z"); // Saturday
    expect(c).toContain("US equities/ETFs CLOSED");
    expect(c).toContain("FX majors CLOSED");
  });
  it("FX reopens Sunday 22:00 UTC", () => {
    expect(ctx("2026-08-30T21:59:00Z")).toContain("FX majors CLOSED");
    expect(ctx("2026-08-30T22:01:00Z")).toContain("FX majors OPEN");
  });
  it("FX closes Friday 22:00 UTC", () => {
    expect(ctx("2026-08-28T21:59:00Z")).toContain("FX majors OPEN");
    expect(ctx("2026-08-28T22:01:00Z")).toContain("FX majors CLOSED");
  });
});

describe("futures session", () => {
  it("is open overnight on a weekday and closed during the daily break and weekend", () => {
    expect(marketSessionContext(new Date("2026-09-03T03:00:00Z"))).toMatch(/futures[^;]*OPEN/);
    expect(marketSessionContext(new Date("2026-09-03T21:30:00Z"))).toMatch(/futures[^;]*CLOSED/);
    expect(marketSessionContext(new Date("2026-09-05T15:00:00Z"))).toMatch(/futures[^;]*CLOSED/);
  });
});
