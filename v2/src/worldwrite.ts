// SPDX-License-Identifier: MIT-0
import { config } from "./config.js";
import { resolve } from "./quotes/resolver.js";
import { putAudit } from "./audit.js";
import { gateNode, gateEdge, gateFact, judgeLink, type GateDeps, type Verdict } from "./gate.js";
import {
  getNode,
  upsertNode,
  upsertEdge,
  upsertFact,
  normalizeId,
  type NodeType,
  type Relation,
  type WorldEdge,
  type WorldFact,
  type WorldNode,
} from "./world.js";

/**
 * The agent's write path into the world model: every proposal is gated, every
 * verdict is audited (stage v3-world-proposal) so the letter and dashboard can
 * count what the evidence supported and what it did not.
 */

export const gateDeps: GateDeps = {
  livePrice: async (symbol) => {
    try {
      const r = await resolve(symbol, "auto");
      return r.ok ? r.quote.price : null;
    } catch {
      return null;
    }
  },
  judge: judgeLink,
};

const hours = (h: number | null) => (h === null ? null : new Date(Date.now() + h * 3_600_000).toISOString());

/** Price-like facts go stale in hours; positions of storms in half a day; the rest in three days. */
export function defaultFactHours(type: NodeType, key: string): number {
  const k = key.toLowerCase();
  if (["price", "level", "spot", "last", "close", "quote"].includes(k)) return 6;
  if (type === "storm") return 12;
  return 72;
}
export function defaultEdgeHours(rel: Relation): number | null {
  if (rel === "threatens") return 24;
  if (rel === "exposure") return 7 * 24;
  return null;
}

export interface FactProposal {
  subject_type: NodeType;
  subject_id: string;
  label?: string;
  props?: Record<string, unknown>;
  key: string;
  value: number | string;
  unit?: string;
  as_of?: string;
  source: string;
  confidence: number;
  expires_hours?: number;
}

export interface LinkProposal {
  from_type?: NodeType;
  from_id: string;
  from_label?: string;
  from_props?: Record<string, unknown>;
  relation?: Relation;
  to_type: NodeType;
  to_id: string;
  to_label?: string;
  to_props?: Record<string, unknown>;
  sign: -1 | 0 | 1;
  mechanism: string;
  source: string;
  confidence: number;
  expires_hours?: number;
}

export interface ProposalResult {
  accepted: boolean;
  verdict: Verdict;
  written?: unknown;
}

async function audit(newsId: string | undefined, kind: string, proposal: unknown, verdict: Verdict): Promise<void> {
  await putAudit(newsId ?? "world-model", "v3-world-proposal", { kind, proposal, verdict }).catch((e) =>
    console.error("[world] audit failed:", e),
  );
}

async function ensureNode(
  type: NodeType,
  id: string,
  label: string | undefined,
  props: Record<string, unknown> | undefined,
  source: string,
  confidence: number,
  newsId: string | undefined,
): Promise<{ node: WorldNode | null; verdict: Verdict | null }> {
  const existing = await getNode(type, id);
  if (existing) {
    if (props && Object.keys(props).length > 0) {
      return { node: await upsertNode({ ...existing, props: { ...existing.props, ...props }, source, confidence }), verdict: null };
    }
    return { node: existing, verdict: null };
  }
  const lbl = label ?? (type === "instrument" || type === "contract" ? id : undefined);
  if (!lbl) {
    const verdict: Verdict = { accepted: false, check: "schema", reason: `unknown ${type} "${id}" — provide a label (and props: lat/lon for storms, region for landfall contracts, quote_symbol for commodities) to create it` };
    await audit(newsId, "node", { type, id }, verdict);
    return { node: null, verdict };
  }
  const candidate = { type, id, label: lbl, props: props ?? {} };
  const verdict = await gateNode(candidate, gateDeps);
  await audit(newsId, "node", candidate, verdict);
  if (!verdict.accepted) return { node: null, verdict };
  const now = new Date().toISOString();
  const node = await upsertNode({ ...candidate, source, confidence, observed_at: now, expires_at: null });
  return { node, verdict };
}

export async function proposeFact(a: FactProposal, newsId?: string): Promise<ProposalResult> {
  const id = normalizeId(a.subject_type, a.subject_id);
  const { node, verdict: nv } = await ensureNode(a.subject_type, id, a.label, a.props, a.source, a.confidence, newsId);
  if (!node) return { accepted: false, verdict: nv! };
  const now = new Date().toISOString();
  const fact: WorldFact = {
    subject: { type: a.subject_type, id },
    key: a.key.trim().toLowerCase().replace(/\s+/g, "_"),
    value: a.value,
    unit: a.unit,
    as_of: a.as_of ?? now,
    source: a.source,
    confidence: a.confidence,
    expires_at: hours(a.expires_hours ?? defaultFactHours(a.subject_type, a.key)),
    observed_at: now,
  };
  const verdict = await gateFact(fact, node, gateDeps);
  await audit(newsId, "fact", fact, verdict);
  if (verdict.accepted) await upsertFact(fact);
  return { accepted: verdict.accepted, verdict, written: verdict.accepted ? fact : undefined };
}

export async function proposeLink(a: LinkProposal, newsId?: string): Promise<ProposalResult> {
  const fromType: NodeType = a.from_type ?? (a.from_id.includes(":") ? "contract" : "instrument");
  const fromId = normalizeId(fromType, a.from_id);
  const toId = normalizeId(a.to_type, a.to_id);
  const f = await ensureNode(fromType, fromId, a.from_label, a.from_props, a.source, a.confidence, newsId);
  if (!f.node) return { accepted: false, verdict: f.verdict! };
  const t = await ensureNode(a.to_type, toId, a.to_label, a.to_props, a.source, a.confidence, newsId);
  if (!t.node) return { accepted: false, verdict: t.verdict! };
  const rel: Relation = a.relation ?? "exposure";
  const now = new Date().toISOString();
  const edge: WorldEdge = {
    from: { type: fromType, id: fromId },
    rel,
    to: { type: a.to_type, id: toId },
    sign: a.sign,
    mechanism: a.mechanism.trim(),
    source: a.source,
    confidence: a.confidence,
    observed_at: now,
    expires_at: hours(a.expires_hours ?? defaultEdgeHours(rel)),
  };
  const verdict = await gateEdge(edge, f.node, t.node, gateDeps);
  await audit(newsId, "edge", edge, verdict);
  if (verdict.accepted) await upsertEdge(edge);
  return { accepted: verdict.accepted, verdict, written: verdict.accepted ? edge : undefined };
}

/** Tools call this; keeps the arm name out of the tool code. */
export const worldModelEnabled = (): boolean => config.worldModel;
