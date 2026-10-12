// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from "vitest";
import { printPlan } from "../src/print.js";

// printPlan is the pure half of print.ts: it decides WHAT would be spawned from
// the platform and environment, so the platform gating can be checked without a
// printer, CUPS or a child process. printPdf itself only executes the plan.

const PDF = "/tmp/letters/2026-01-31.pdf";

describe("printPlan", () => {
  it("macOS without V2_PRINT_CMD uses CUPS lp with the default queue (unchanged behaviour)", () => {
    const plan = printPlan(PDF, undefined, "darwin", {});
    expect(plan).toEqual({ kind: "cups", bin: "/usr/bin/lp", args: [PDF] });
  });

  it("macOS with a printer name passes -d <printer> before the PDF", () => {
    const plan = printPlan(PDF, "Office_Laser", "darwin", {});
    expect(plan).toEqual({ kind: "cups", bin: "/usr/bin/lp", args: ["-d", "Office_Laser", PDF] });
  });

  it("other platforms without V2_PRINT_CMD are unavailable and name the fix", () => {
    for (const platform of ["linux", "win32", "freebsd"] as const) {
      const plan = printPlan(PDF, "Office_Laser", platform, {});
      expect(plan.kind).toBe("unavailable");
      if (plan.kind === "unavailable") {
        expect(plan.reason).toContain("printing not available on this platform");
        expect(plan.reason).toContain(platform);
        expect(plan.reason).toContain("V2_PRINT_CMD");
      }
    }
  });

  it("V2_PRINT_CMD runs the command with the PDF path as its only argument, on any platform", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const plan = printPlan(PDF, "Office_Laser", platform, { V2_PRINT_CMD: "/usr/local/bin/mail-pdf" });
      expect(plan).toEqual({ kind: "command", bin: "/usr/local/bin/mail-pdf", args: [PDF] });
    }
  });

  it("a blank V2_PRINT_CMD counts as unset", () => {
    expect(printPlan(PDF, undefined, "linux", { V2_PRINT_CMD: "   " }).kind).toBe("unavailable");
    expect(printPlan(PDF, undefined, "darwin", { V2_PRINT_CMD: "" }).kind).toBe("cups");
  });
});
