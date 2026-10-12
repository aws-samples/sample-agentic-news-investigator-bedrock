// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import { bedrock } from "./bedrock.js";
import { guardedCall, messageIntervened, type GuardrailRef } from "./guardrail.js";
import { activeGuardrail } from "./guardrail-runtime.js";

/**
 * The truth gate in front of the world model. Everything the agent proposes
 * passes here before it is written, because a fabricated link that costs one
 * wasted investigation today would, once written, steer every later decision
 * that touches the node. Deterministic checks decide where they can (basins,
 * instrument identity, price facts against live quotes); a cheap judge decides
 * whether a causal link is direct; everything else is accepted with an expiry.
 */

export type Basin = "atlantic" | "pacific" | "other";

/**
 * Approximate tropical-cyclone basin from a position. Good enough to tell a
 * Gulf/Caribbean/Atlantic system from an eastern or central Pacific one, which
 * is the mistake the agent actually made ("Karina could reach the Gulf Coast").
 * The Central American isthmus is the awkward part: north of 18N the Pacific
 * coast of Mexico lies west of ~103W, south of it the Caribbean side lies east
 * of ~83W. Panama's Pacific gulf misclassifies; storms do not form there.
 */
export function basinOf(lat: number, lon: number): Basin {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "other";
  if (lat < 0 || lat > 60) return "other";
  if (lon > 0 && lon < 100) return "other"; // Indian Ocean / Med
  if (lon >= 100) return "other"; // West Pacific (positive longitudes)
  if (lon >= -60) return "atlantic";
  if (lat >= 18 && lon >= -100) return "atlantic";
  if (lat < 18 && lon >= -83) return "atlantic";
  return "pacific";
}

/** Basins of the regions the book has cared about; other regions carry it in props. */
export const REGION_BASINS: Record<string, Basin> = {
  texas: "atlantic",
  louisiana: "atlantic",
  "us-gulf-coast": "atlantic",
  "gulf-of-mexico": "atlantic",
  florida: "atlantic",
  "us-east-coast": "atlantic",
  caribbean: "atlantic",
  hawaii: "pacific",
  california: "pacific",
  "mexico-pacific-coast": "pacific",
  "baja-california": "pacific",
};

export interface Verdict {
  accepted: boolean;
  check: "basin" | "instrument" | "price" | "judge" | "schema" | "none";
  reason: string;
}

const ok = (check: Verdict["check"], reason: string): Verdict => ({ accepted: true, check, reason });
const no = (check: Verdict["check"], reason: string): Verdict => ({ accepted: false, check, reason });

export interface GateDeps {
  /** Resolver: does this symbol exist with a live price? Returns the price or null. */
  livePrice: (symbol: string) => Promise<number | null>;
  /** Cheap judge for causal directness. */
  judge: (question: Record<string, unknown>) => Promise<{ accept: boolean; reason: string }>;
}

export interface NodeLike {
  type: string;
  id: string;
  label: string;
  props: Record<string, unknown>;
}

/** Storm → region: the storm's basin must be the region's basin. */
export function basinConflict(storm: NodeLike, region: NodeLike): string | null {
  const sb = storm.props.basin as Basin | undefined;
  const rb = (region.props.basin as Basin | undefined) ?? REGION_BASINS[region.id];
  if (!sb) return `storm ${storm.label} has no position (lat/lon) — record its coordinates first`;
  if (!rb) return null; // unknown region basin: cannot rule out
  if (sb !== rb) return `${storm.label} is in the ${sb} basin; ${region.label} is on the ${rb} side — it cannot make landfall there`;
  return null;
}

/** Numeric price/level facts are checked against the live quote when the subject has one. */
export function priceDeviation(value: number, live: number): number {
  if (!(live > 0)) return 0;
  return Math.abs(value / live - 1);
}
export const PRICE_TOLERANCE = 0.05;

const PRICE_KEYS = new Set(["price", "level", "spot", "last", "close", "quote"]);

export async function gateNode(n: NodeLike, deps: GateDeps): Promise<Verdict> {
  if (!n.label || n.label.trim().length < 2) return no("schema", "a node needs a label");
  if (n.type === "instrument" || n.type === "contract") {
    const p = await deps.livePrice(n.id);
    if (p === null) return no("instrument", `${n.id} does not resolve to a live quote; it does not exist for this system`);
    return ok("instrument", `resolves (live ${p})`);
  }
  if (n.type === "storm") {
    const lat = Number(n.props.lat), lon = Number(n.props.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return no("schema", "a storm needs numeric lat and lon in props (from the advisory)");
    return ok("basin", `positioned at ${lat},${lon} → ${basinOf(lat, lon)} basin`);
  }
  return ok("none", "accepted");
}

export async function gateEdge(
  e: { rel: string; sign: number; mechanism: string; confidence: number },
  from: NodeLike,
  to: NodeLike,
  deps: GateDeps,
): Promise<Verdict> {
  if (!e.mechanism || e.mechanism.trim().length < 20) return no("schema", "spell out the causal mechanism (at least a sentence)");
  // Geography is decidable: a storm can only threaten, or expose a landfall contract in, its own basin.
  const storm = from.type === "storm" ? from : to.type === "storm" ? to : null;
  const region = from.type === "region" ? from : to.type === "region" ? to : null;
  if (storm && region) {
    const c = basinConflict(storm, region);
    return c ? no("basin", c) : ok("basin", "same basin");
  }
  if (storm && (to.type === "contract" || from.type === "contract")) {
    const contract = to.type === "contract" ? to : from;
    const regionId = String(contract.props.region ?? "");
    if (regionId && (REGION_BASINS[regionId] || contract.props.region_basin)) {
      const c = basinConflict(storm, { type: "region", id: regionId, label: regionId, props: { basin: contract.props.region_basin } });
      if (c) return no("basin", c);
    }
  }
  if (e.rel === "located_in") return ok("none", "accepted");
  // Everything else is a causal claim: the judge decides whether it is direct.
  const j = await deps.judge({ from: { type: from.type, id: from.id, label: from.label, props: from.props }, to: { type: to.type, id: to.id, label: to.label, props: to.props }, relation: e.rel, sign: e.sign, mechanism: e.mechanism });
  return j.accept ? ok("judge", j.reason) : no("judge", j.reason);
}

export async function gateFact(
  f: { key: string; value: number | string; unit?: string; as_of: string },
  subject: NodeLike,
  deps: GateDeps,
): Promise<Verdict> {
  if (!f.key || !f.as_of || Number.isNaN(Date.parse(f.as_of))) return no("schema", "a fact needs a key and an ISO as_of timestamp");
  if (typeof f.value === "number" && PRICE_KEYS.has(f.key.toLowerCase())) {
    const quoteSymbol =
      (typeof subject.props.quote_symbol === "string" && subject.props.quote_symbol) ||
      (subject.type === "instrument" || subject.type === "contract" ? subject.id : null);
    if (quoteSymbol) {
      const live = await deps.livePrice(quoteSymbol);
      if (live !== null) {
        const dev = priceDeviation(f.value, live);
        if (dev > PRICE_TOLERANCE) {
          return no("price", `${subject.label} ${f.key} ${f.value} is ${(dev * 100).toFixed(1)}% away from the live quote ${live} (${quoteSymbol}) — check which instrument the headline actually meant`);
        }
        return ok("price", `within ${(dev * 100).toFixed(1)}% of live ${live}`);
      }
    }
  }
  return ok("none", "accepted");
}

const JUDGE_SYSTEM = `You judge whether a proposed causal link in a trading agent's shared world model is DIRECT enough to be written down and relied on by later decisions.
ACCEPT only when: (a) the driver mechanically determines the instrument's payoff or price — its settlement source, its underlying, the issuer of the security, index membership; or (b) the mechanism names a well-established causal channel with at most one intermediate step (a Gulf hurricane -> Gulf refinery outages -> crude and product prices).
REJECT: shared geography without a mechanism ("Gulf Coast footprint"), shared theme or sector, temporal coincidence ("filed during hurricane season"), speculative chains of three or more steps, or a mechanism that only restates the conclusion.
Respond with ONLY JSON: {"accept": true|false, "reason": "one sentence"}`;

export async function judgeLink(
  question: Record<string, unknown>,
  guardrail?: GuardrailRef | null,
): Promise<{ accept: boolean; reason: string }> {
  try {
    // The whole proposal is guard content: the agent wrote it from untrusted text.
    const g = guardedCall(activeGuardrail(guardrail));
    const resp = await bedrock.messages.create(
      g.body({
        model: config.triageModel,
        max_tokens: 200,
        system: JUDGE_SYSTEM,
        messages: [{ role: "user" as const, content: g.tag(JSON.stringify(question)) }],
      }),
      { headers: g.headers },
    );
    if (g.active && messageIntervened(resp)) {
      return { accept: false, reason: "guardrail: the Bedrock guardrail blocked this proposal; not written" };
    }
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    return { accept: parsed.accept === true, reason: String(parsed.reason ?? "") };
  } catch (e) {
    // A judge outage must not silently admit links: fail closed, say why.
    return { accept: false, reason: `judge unavailable (${e instanceof Error ? e.message : String(e)}); resubmit later` };
  }
}
