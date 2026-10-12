// SPDX-License-Identifier: MIT-0
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * The outbound guard for URLs that arrive inside news (threat model T03 / M07).
 *
 * `read_source` fetches the event's own `url`, and an event's url is whatever the
 * feed entry said — attacker-influenced for any feed that syndicates third-party
 * items. Unguarded, a crafted item pointing at `http://169.254.169.254/…` (the
 * instance metadata service), a loopback admin port, or an RFC1918 host would have
 * the worker fetch it and hand the body to the model, which may repeat it into a
 * transcript. Plain `fetch` also follows redirects silently, so a public URL that
 * 302s to one of those is the same attack.
 *
 * Policy: https only (an `http:` link is upgraded rather than refused — feeds still
 * emit them, and every source we read serves https), default port only, no userinfo,
 * and every address the hostname resolves to must be public. Redirects are followed
 * by hand, at most `MAX_REDIRECTS`, each hop re-checked.
 *
 * Residual: the check resolves, then `fetch` resolves again, so a DNS answer that
 * changes in between (rebinding) is not caught here. On EC2 that is covered by
 * IMDSv2 with hop limit 1 (a bare GET gets no credentials); elsewhere nothing
 * internal should be reachable from the worker in the first place.
 */

export class UrlRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlRefused";
  }
}

const MAX_REDIRECTS = 3;

const denied = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. the EC2/ECS metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast
] as const) {
  denied.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 — maps onto IPv4 space we cannot see through
  ["fc00::", 7], // unique local, incl. the EC2 IPv6 metadata endpoint fd00:ec2::254
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  denied.addSubnet(net, prefix, "ipv6");
}

/** True when `addr` (an IP literal) is routable on the public internet. */
export function isPublicAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return !denied.check(addr, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:hhhh:hhhh): judge the embedded IPv4.
    const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(addr);
    if (mapped) {
      const v4 = mapped[1] ?? hexPairToV4(mapped[2], mapped[3]);
      return isPublicAddress(v4);
    }
    return !denied.check(addr, "ipv6");
  }
  return false;
}

function hexPairToV4(hi: string, lo: string): string {
  const a = parseInt(hi, 16);
  const b = parseInt(lo, 16);
  return [a >> 8, a & 255, b >> 8, b & 255].join(".");
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/**
 * Validate one URL against the policy and return the URL to fetch (possibly
 * upgraded to https). Throws `UrlRefused` with a reason the agent can read.
 */
export async function checkUrl(raw: string, resolve: Resolver = systemResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRefused(`not a URL: ${raw}`);
  }
  if (url.protocol === "http:") {
    if (url.port && url.port !== "80") throw new UrlRefused(`non-default port ${url.port}`);
    url.protocol = "https:";
    url.port = "";
  }
  if (url.protocol !== "https:") throw new UrlRefused(`scheme ${url.protocol} is not allowed`);
  if (url.port && url.port !== "443") throw new UrlRefused(`non-default port ${url.port}`);
  if (url.username || url.password) throw new UrlRefused("credentials in URL");
  // WHATWG URL has already normalised 0x7f.1, 2130706433 and friends to dotted
  // quads; IPv6 literals keep their brackets in `hostname`.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await resolve(host);
    } catch (e) {
      throw new UrlRefused(`cannot resolve ${host}: ${String(e)}`);
    }
  }
  if (addrs.length === 0) throw new UrlRefused(`${host} has no addresses`);
  const bad = addrs.find((a) => !isPublicAddress(a));
  if (bad) throw new UrlRefused(`${host} resolves to non-public address ${bad}`);
  return url;
}

export interface GuardedFetchOpts {
  resolve?: Resolver;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

/** `fetch` behind `checkUrl`, with redirects followed by hand and re-checked. */
export async function guardedFetch(
  raw: string,
  init: RequestInit,
  opts: GuardedFetchOpts = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const max = opts.maxRedirects ?? MAX_REDIRECTS;
  let next = raw;
  for (let hop = 0; ; hop++) {
    const url = await checkUrl(next, opts.resolve);
    const resp = await doFetch(url, { ...init, redirect: "manual" });
    if (resp.status < 300 || resp.status >= 400 || resp.status === 304) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp;
    await resp.body?.cancel().catch(() => {});
    if (hop >= max) throw new UrlRefused(`more than ${max} redirects`);
    next = new URL(location, url).toString();
  }
}
