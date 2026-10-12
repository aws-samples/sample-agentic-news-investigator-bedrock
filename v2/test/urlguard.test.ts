// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from "vitest";
import { checkUrl, guardedFetch, isPublicAddress, UrlRefused, type Resolver } from "../src/urlguard.js";

const dns = (table: Record<string, string[]>): Resolver => async (host) => {
  const a = table[host];
  if (!a) throw new Error("ENOTFOUND");
  return a;
};
const publicDns = dns({ "example.com": ["93.184.215.14"], "www.sec.gov": ["23.33.0.1", "2600:1408::1"] });

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.170.2", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe",
  ])("refuses %s", (a) => expect(isPublicAddress(a)).toBe(false));

  it.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "2600:1408::1", "::ffff:8.8.8.8"])(
    "allows %s",
    (a) => expect(isPublicAddress(a)).toBe(true),
  );

  it("is false for things that are not addresses", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("checkUrl", () => {
  it("passes a public https URL through", async () => {
    expect((await checkUrl("https://example.com/a?b=1", publicDns)).toString()).toBe("https://example.com/a?b=1");
  });

  it("upgrades http to https", async () => {
    expect((await checkUrl("http://example.com/x", publicDns)).toString()).toBe("https://example.com/x");
  });

  it.each([
    ["the metadata service", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["the ECS credentials endpoint", "http://169.254.170.2/v2/credentials"],
    ["the IPv6 metadata endpoint", "https://[fd00:ec2::254]/latest/meta-data/"],
    ["loopback", "https://127.0.0.1/"],
    ["a decimal loopback literal", "http://2130706433/"],
    ["a hex loopback literal", "http://0x7f.1/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["RFC1918", "https://10.0.0.5/admin"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com/x"],
    ["data:", "data:text/plain,hi"],
    ["a non-default https port", "https://example.com:8443/"],
    ["a non-default http port", "http://example.com:8080/"],
    ["userinfo", "https://user:pw@example.com/"], // pragma: allowlist secret
    ["garbage", "not a url"],
  ])("refuses %s", async (_why, u) => {
    await expect(checkUrl(u, publicDns)).rejects.toBeInstanceOf(UrlRefused);
  });

  it("refuses a hostname that resolves to a private address", async () => {
    const r = dns({ "evil.test": ["93.184.215.14", "10.0.0.1"] });
    await expect(checkUrl("https://evil.test/", r)).rejects.toThrow(/non-public address 10\.0\.0\.1/);
  });

  it("refuses a hostname that does not resolve", async () => {
    await expect(checkUrl("https://nowhere.test/", publicDns)).rejects.toThrow(/cannot resolve/);
  });
});

describe("guardedFetch", () => {
  const redirecting = (hops: Record<string, string>) => {
    const seen: string[] = [];
    const impl = (async (input: URL | string, init?: RequestInit) => {
      const u = String(input);
      seen.push(u);
      expect(init?.redirect).toBe("manual");
      const to = hops[u];
      return to
        ? new Response(null, { status: 302, headers: { location: to } })
        : new Response("ok", { status: 200 });
    }) as typeof fetch;
    return { impl, seen };
  };

  it("follows a public redirect chain, re-checking each hop", async () => {
    const { impl, seen } = redirecting({
      "https://example.com/a": "/b",
      "https://example.com/b": "http://www.sec.gov/c",
    });
    const r = await guardedFetch("https://example.com/a", {}, { resolve: publicDns, fetchImpl: impl });
    expect(await r.text()).toBe("ok");
    expect(seen).toEqual(["https://example.com/a", "https://example.com/b", "https://www.sec.gov/c"]);
  });

  it("refuses a redirect to the metadata service without fetching it", async () => {
    const { impl, seen } = redirecting({ "https://example.com/a": "http://169.254.169.254/latest/meta-data/" });
    await expect(guardedFetch("https://example.com/a", {}, { resolve: publicDns, fetchImpl: impl })).rejects.toBeInstanceOf(
      UrlRefused,
    );
    expect(seen).toEqual(["https://example.com/a"]);
  });

  it("caps the number of redirects", async () => {
    const { impl } = redirecting({
      "https://example.com/1": "/2",
      "https://example.com/2": "/3",
      "https://example.com/3": "/4",
      "https://example.com/4": "/5",
    });
    await expect(
      guardedFetch("https://example.com/1", {}, { resolve: publicDns, fetchImpl: impl, maxRedirects: 3 }),
    ).rejects.toThrow(/more than 3 redirects/);
  });

  it("never calls fetch for a refused URL", async () => {
    const { impl, seen } = redirecting({});
    await expect(guardedFetch("http://127.0.0.1:8080/", {}, { resolve: publicDns, fetchImpl: impl })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});
