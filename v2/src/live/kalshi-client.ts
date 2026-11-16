// SPDX-License-Identifier: MIT-0
import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Kalshi trade API client: signed requests for the live broker (broker.ts) and the operator CLI
 * (cli.ts), plus the public order book that shadow mode reads without any key.
 *
 * Auth (docs.kalshi.com, API keys, checked 2026-10-30): every request carries KALSHI-ACCESS-KEY
 * (the key id), KALSHI-ACCESS-TIMESTAMP (ms) and KALSHI-ACCESS-SIGNATURE = base64 signature of
 * `timestamp + METHOD + path`, where path is the full path from the root (`/trade-api/v2/...`)
 * WITHOUT the query string. Ed25519 keys sign the text directly; RSA keys use RSA-PSS SHA-256
 * with MGF1 SHA-256 and salt length = digest length. Same scheme on demo and prod.
 */

export const KALSHI_BASE = {
  demo: "https://external-api.demo.kalshi.co/trade-api/v2",
  prod: "https://api.elections.kalshi.com/trade-api/v2",
} as const;
export type KalshiEnv = keyof typeof KALSHI_BASE;

/** The signature header value. Pure apart from the key object; tested with generated keys. */
export function signKalshi(privateKey: crypto.KeyObject, timestampMs: string, method: string, pathFromRoot: string): string {
  const text = timestampMs + method.toUpperCase() + pathFromRoot.split("?")[0];
  if (privateKey.asymmetricKeyType === "ed25519") {
    return crypto.sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
  }
  return crypto
    .sign("sha256", Buffer.from(text, "utf8"), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

export class KalshiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly path: string,
  ) {
    super(`kalshi ${path}: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

export interface KalshiCredentials {
  keyId: string;
  /** PEM text of the private key (never logged). */
  privateKeyPem: string;
}

/** Credentials from env: V2_KALSHI_KEY_ID plus V2_KALSHI_KEY_PEM (inline) or V2_KALSHI_KEY_PATH (file). */
export function credentialsFromEnv(env = process.env): KalshiCredentials | null {
  const keyId = env.V2_KALSHI_KEY_ID ?? "";
  const pem = env.V2_KALSHI_KEY_PEM || (env.V2_KALSHI_KEY_PATH ? fs.readFileSync(env.V2_KALSHI_KEY_PATH, "utf8") : "");
  return keyId && pem ? { keyId, privateKeyPem: pem } : null;
}

export class KalshiClient {
  private readonly key: crypto.KeyObject | null;
  private readonly root: string;

  constructor(
    readonly env: KalshiEnv,
    private readonly creds: KalshiCredentials | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.key = creds ? crypto.createPrivateKey(creds.privateKeyPem) : null;
    this.root = new URL(KALSHI_BASE[env]).pathname; // "/trade-api/v2"
  }

  private async call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, signed = true): Promise<any> {
    const headers: Record<string, string> = { "user-agent": "fin-live/0.1", accept: "application/json" };
    if (signed) {
      if (!this.key || !this.creds) throw new Error("kalshi: no API credentials (V2_KALSHI_KEY_ID + V2_KALSHI_KEY_PATH/PEM)");
      const ts = String(Date.now());
      headers["KALSHI-ACCESS-KEY"] = this.creds.keyId;
      headers["KALSHI-ACCESS-TIMESTAMP"] = ts;
      headers["KALSHI-ACCESS-SIGNATURE"] = signKalshi(this.key, ts, method, this.root + path);
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await this.fetchFn(KALSHI_BASE[this.env] + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    if (!r.ok) throw new KalshiError(r.status, text, path);
    return text ? JSON.parse(text) : {};
  }

  /** Public: no key needed. */
  orderbook(ticker: string, depth = 50): Promise<any> {
    return this.call("GET", `/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`, undefined, false);
  }
  market(ticker: string): Promise<any> {
    return this.call("GET", `/markets/${encodeURIComponent(ticker)}`, undefined, false);
  }
  balance(): Promise<any> {
    return this.call("GET", "/portfolio/balance");
  }
  async positions(): Promise<any> {
    const all: any[] = [];
    let cursor = "";
    do {
      const r = await this.call("GET", `/portfolio/positions?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...(r.market_positions ?? []));
      cursor = r.cursor ?? "";
    } while (cursor);
    return { market_positions: all };
  }
  fills(limit = 100): Promise<any> {
    return this.call("GET", `/portfolio/fills?limit=${limit}`);
  }
  createOrder(order: unknown): Promise<any> {
    return this.call("POST", "/portfolio/events/orders", order);
  }
  cancelOrder(orderId: string): Promise<any> {
    return this.call("DELETE", `/portfolio/events/orders/${encodeURIComponent(orderId)}`);
  }
}
