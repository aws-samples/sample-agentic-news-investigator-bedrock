// SPDX-License-Identifier: MIT-0
import { describe, it, expect, vi, beforeEach } from "vitest";

// SSM and DynamoDB are both faked: nothing here reaches AWS.
const ssmSend = vi.fn();
const ddbSend = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    send = ssmSend;
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("../src/ledger.js", () => ({ ddb: { send: ddbSend } }));

async function freshBudget() {
  vi.resetModules(); // budget.ts caches parameters per module instance
  return import("../src/budget.js");
}

beforeEach(() => {
  ssmSend.mockReset();
  ddbSend.mockReset();
  ddbSend.mockResolvedValue({ Item: { cost_usd: 1, investigations: 1 } });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("budget fails closed", () => {
  it("treats an unreadable kill switch as ON", async () => {
    ssmSend.mockRejectedValue(new Error("AccessDeniedException"));
    const b = await freshBudget();
    expect(await b.killSwitchOn()).toBe(true);
  });

  it("treats a missing kill switch parameter as ON", async () => {
    ssmSend.mockRejectedValue(Object.assign(new Error("not found"), { name: "ParameterNotFound" }));
    const b = await freshBudget();
    expect(await b.killSwitchOn()).toBe(true);
  });

  it("reads the kill switch when SSM answers", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "false" } });
    const b = await freshBudget();
    expect(await b.killSwitchOn()).toBe(false);
  });

  it("allows nothing when the daily budget cannot be read", async () => {
    ssmSend.mockRejectedValue(new Error("ThrottlingException"));
    const b = await freshBudget();
    const news = await b.checkBudget();
    const priority = await b.checkBudget({ priority: true });
    expect(news.allowed).toBe(false);
    expect(news.reason).toContain("unreadable (fail closed)");
    expect(priority.allowed).toBe(false);
  });

  it("allows nothing when the daily budget is not a number", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "lots" } });
    const b = await freshBudget();
    expect((await b.checkBudget()).allowed).toBe(false);
  });

  it("applies the configured ceiling when SSM answers", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "100" } });
    const b = await freshBudget();
    expect((await b.checkBudget()).allowed).toBe(true);
  });
});
