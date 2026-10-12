// SPDX-License-Identifier: MIT-0
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb } from "./ledger.js";
import { REGION_BASINS, basinOf, type Basin } from "./gate.js";

/**
 * v3's world model: a small, hand-written ontology that investigations read
 * before acting and write to through a gate (gate.ts). It exists because every
 * judgment failure the letters flagged was a world-model failure — an egg
 * producer's 8-K "touching" a hurricane bet, a Pacific storm "reaching the
 * Gulf", Brent quoted as WTI — and the agent had nowhere to keep what it had
 * already established. Lives in the arm's own table under WM# keys.
 *
 *   node  pk WM#NODE#<type>#<id>          sk -                      gsi1 WM#TYPE#<type> / <id>
 *   edge  pk WM#EDGE#<fromType>#<fromId>  sk <rel>#<toType>#<toId>  gsi1 WM#IN#<toType>#<toId> / <rel>#<fromType>#<fromId>
 *   fact  pk WM#FACT#<type>#<id>          sk <key>                  gsi1 WM#FACTS / <expires_at>#<type>#<id>#<key>
 */

export const NODE_TYPES = [
  "instrument",
  "issuer",
  "contract",
  "storm",
  "region",
  "commodity",
  "indicator",
  "event",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const RELATIONS = [
  "exposure",
  "threatens",
  "located_in",
  "resolves_on",
  "tracks",
  "issued_by",
] as const;
export type Relation = (typeof RELATIONS)[number];

export interface NodeRef {
  type: NodeType;
  id: string;
}

export interface WorldNode extends NodeRef {
  label: string;
  props: Record<string, unknown>;
  source: string;
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  updated_at: string;
}

export interface WorldEdge {
  from: NodeRef;
  rel: Relation;
  to: NodeRef;
  /** +1 the driver rising/strengthening helps the instrument, -1 hurts, 0 unsigned. */
  sign: -1 | 0 | 1;
  mechanism: string;
  source: string;
  confidence: number;
  observed_at: string;
  expires_at: string | null;
}

export interface WorldFact {
  subject: NodeRef;
  key: string;
  value: number | string;
  unit?: string;
  as_of: string;
  source: string;
  confidence: number;
  expires_at: string | null;
  observed_at: string;
}

/** Ids for everything except instruments (whose id is the resolver symbol, case kept). */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeId(type: NodeType, id: string): string {
  return type === "instrument" || type === "contract" ? id.trim() : slug(id);
}

const nodeKey = (r: NodeRef) => ({ pk: `WM#NODE#${r.type}#${r.id}`, sk: "-" });
const NEVER = "9999-12-31T00:00:00.000Z";

export async function getNode(type: NodeType, id: string): Promise<WorldNode | null> {
  const r = await ddb.send(new GetCommand({ TableName: config.table, Key: nodeKey({ type, id }) }));
  return (r.Item as (WorldNode & Record<string, unknown>) | undefined) ? toNode(r.Item as any) : null;
}

function toNode(item: any): WorldNode {
  return {
    type: item.type,
    id: item.id,
    label: item.label,
    props: item.props ?? {},
    source: item.source ?? "",
    confidence: Number(item.confidence ?? 0),
    observed_at: item.observed_at,
    expires_at: item.expires_at ?? null,
    updated_at: item.updated_at,
  };
}

export async function upsertNode(n: Omit<WorldNode, "updated_at">): Promise<WorldNode> {
  const existing = await getNode(n.type, n.id);
  const node: WorldNode = {
    ...n,
    // Props merge so a later, narrower proposal never erases what is known.
    props: { ...(existing?.props ?? {}), ...n.props },
    updated_at: new Date().toISOString(),
  };
  if (node.type === "storm") {
    const lat = Number(node.props.lat), lon = Number(node.props.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) node.props.basin = basinOf(lat, lon);
  }
  if (node.type === "region" && !node.props.basin && REGION_BASINS[node.id]) {
    node.props.basin = REGION_BASINS[node.id];
  }
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: { ...nodeKey(node), ...node, gsi1pk: `WM#TYPE#${node.type}`, gsi1sk: node.id },
    }),
  );
  return node;
}

export async function listNodes(type: NodeType, table = config.table): Promise<WorldNode[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": `WM#TYPE#${type}` },
    }),
  );
  return ((r.Items ?? []) as any[]).map(toNode);
}

function toEdge(item: any): WorldEdge {
  return {
    from: item.from,
    rel: item.rel,
    to: item.to,
    sign: item.sign ?? 0,
    mechanism: item.mechanism ?? "",
    source: item.source ?? "",
    confidence: Number(item.confidence ?? 0),
    observed_at: item.observed_at,
    expires_at: item.expires_at ?? null,
  };
}

export async function upsertEdge(e: WorldEdge): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        pk: `WM#EDGE#${e.from.type}#${e.from.id}`,
        sk: `${e.rel}#${e.to.type}#${e.to.id}`,
        gsi1pk: `WM#IN#${e.to.type}#${e.to.id}`,
        gsi1sk: `${e.rel}#${e.from.type}#${e.from.id}`,
        ...e,
      },
    }),
  );
}

export async function edgesFrom(type: NodeType, id: string): Promise<WorldEdge[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": `WM#EDGE#${type}#${id}` },
    }),
  );
  return ((r.Items ?? []) as any[]).map(toEdge);
}

export async function edgesInto(type: NodeType, id: string): Promise<WorldEdge[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": `WM#IN#${type}#${id}` },
    }),
  );
  return ((r.Items ?? []) as any[]).map(toEdge);
}

function toFact(item: any): WorldFact {
  return {
    subject: item.subject,
    key: item.key,
    value: item.value,
    unit: item.unit,
    as_of: item.as_of,
    source: item.source ?? "",
    confidence: Number(item.confidence ?? 0),
    expires_at: item.expires_at ?? null,
    observed_at: item.observed_at,
  };
}

export async function upsertFact(f: WorldFact): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: config.table,
      Item: {
        pk: `WM#FACT#${f.subject.type}#${f.subject.id}`,
        sk: f.key,
        gsi1pk: "WM#FACTS",
        gsi1sk: `${f.expires_at ?? NEVER}#${f.subject.type}#${f.subject.id}#${f.key}`,
        ...f,
      },
    }),
  );
}

export async function factsOf(type: NodeType, id: string): Promise<WorldFact[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": `WM#FACT#${type}#${id}` },
    }),
  );
  return ((r.Items ?? []) as any[]).map(toFact);
}

/** Facts whose expiry has passed (facts without expiry never appear). */
export async function expiredFacts(nowIso = new Date().toISOString()): Promise<WorldFact[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: config.table,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p AND gsi1sk < :now",
      ExpressionAttributeValues: { ":p": "WM#FACTS", ":now": nowIso },
    }),
  );
  return ((r.Items ?? []) as any[]).map(toFact);
}

export interface WorldStats {
  nodes: Record<string, number>;
  edges: number;
  facts: number;
}

export async function worldStats(table = config.table): Promise<WorldStats> {
  const nodes: Record<string, number> = {};
  await Promise.all(
    NODE_TYPES.map(async (t) => {
      nodes[t] = (await listNodes(t, table)).length;
    }),
  );
  let edges = 0, facts = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: "begins_with(pk, :e) OR begins_with(pk, :f)",
        ExpressionAttributeValues: { ":e": "WM#EDGE#", ":f": "WM#FACT#" },
        ProjectionExpression: "pk",
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of (r.Items ?? []) as any[]) {
      if (String(it.pk).startsWith("WM#EDGE#")) edges++;
      else facts++;
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return { nodes, edges, facts };
}

// ---------------------------------------------------------------------------
// Views

export interface FactView {
  key: string;
  value: number | string;
  unit?: string;
  as_of: string;
  source: string;
  stale: boolean;
}

export interface DriverView extends NodeRef {
  label: string;
  props: Record<string, unknown>;
  facts: FactView[];
}

export interface ExposureView {
  rel: Relation;
  driver: DriverView;
  sign: -1 | 0 | 1;
  mechanism: string;
  confidence: number;
  stale: boolean;
}

export interface PositionView {
  symbol: string;
  label: string | null;
  props: Record<string, unknown>;
  facts: FactView[];
  exposures: ExposureView[];
}

export interface WorldModelView {
  as_of: string;
  positions: PositionView[];
  warnings: string[];
}

const isStale = (expires: string | null, nowMs: number) => !!expires && Date.parse(expires) < nowMs;

async function driverView(ref: NodeRef, nowMs: number): Promise<DriverView> {
  const [node, facts] = await Promise.all([getNode(ref.type, ref.id), factsOf(ref.type, ref.id)]);
  return {
    type: ref.type,
    id: ref.id,
    label: node?.label ?? ref.id,
    props: node?.props ?? {},
    facts: facts.map((f) => ({
      key: f.key,
      value: f.value,
      unit: f.unit,
      as_of: f.as_of,
      source: f.source,
      stale: isStale(f.expires_at, nowMs),
    })),
  };
}

/** What the model knows about these instruments: node, facts, and what drives them. */
export async function worldModelFor(symbols: string[]): Promise<WorldModelView> {
  const nowMs = Date.now();
  const warnings: string[] = [];
  const positions = await Promise.all(
    symbols.map(async (symbol) => {
      const type: NodeType = symbol.includes(":") ? "contract" : "instrument";
      const [node, facts, edges] = await Promise.all([
        getNode(type, symbol),
        factsOf(type, symbol),
        edgesFrom(type, symbol),
      ]);
      const exposures = await Promise.all(
        edges.map(async (e) => ({
          rel: e.rel,
          driver: await driverView(e.to, nowMs),
          sign: e.sign,
          mechanism: e.mechanism,
          confidence: e.confidence,
          stale: isStale(e.expires_at, nowMs),
        })),
      );
      if (edges.length === 0) warnings.push(`${symbol}: no exposure links recorded — nothing explains what moves it`);
      for (const x of exposures) {
        if (x.stale) warnings.push(`${symbol} → ${x.driver.label}: exposure link expired`);
        for (const f of x.driver.facts) if (f.stale) warnings.push(`${x.driver.label}.${f.key} is stale (as of ${f.as_of})`);
      }
      return {
        symbol,
        label: node?.label ?? null,
        props: node?.props ?? {},
        facts: facts.map((f) => ({ key: f.key, value: f.value, unit: f.unit, as_of: f.as_of, source: f.source, stale: isStale(f.expires_at, nowMs) })),
        exposures,
      };
    }),
  );
  return { as_of: new Date(nowMs).toISOString(), positions, warnings };
}

/** Compact prose for prompts (the agent gets JSON via the tool; this is the pushed context). */
export function renderWorldModel(v: WorldModelView): string {
  const lines: string[] = [];
  for (const p of v.positions) {
    lines.push(`- ${p.symbol}${p.label ? ` (${p.label})` : ""}`);
    for (const f of p.facts) lines.push(`    fact ${f.key} = ${f.value}${f.unit ? ` ${f.unit}` : ""} (as of ${f.as_of}, ${f.source}${f.stale ? ", STALE" : ""})`);
    if (p.exposures.length === 0) lines.push("    exposures: none recorded");
    for (const x of p.exposures) {
      const sign = x.sign > 0 ? "+" : x.sign < 0 ? "−" : "±";
      const basin = x.driver.props.basin ? ` [${x.driver.props.basin} basin]` : "";
      lines.push(`    ${x.rel} ${sign} ${x.driver.type}:${x.driver.label}${basin} — ${x.mechanism} (conf ${x.confidence}${x.stale ? ", EXPIRED" : ""})`);
      for (const f of x.driver.facts) lines.push(`        ${f.key} = ${f.value}${f.unit ? ` ${f.unit}` : ""} (as of ${f.as_of}${f.stale ? ", STALE" : ""})`);
    }
  }
  if (v.warnings.length) lines.push(`warnings: ${v.warnings.join("; ")}`);
  return lines.join("\n") || "(world model empty)";
}

export interface TriageExposure {
  symbol: string;
  label: string | null;
  exposed_to: string[];
}

/** For triage: what actually drives each held instrument, so "touches" means something. */
export async function triageExposures(symbols: string[]): Promise<TriageExposure[]> {
  return Promise.all(
    symbols.map(async (symbol) => {
      const type: NodeType = symbol.includes(":") ? "contract" : "instrument";
      const [node, edges] = await Promise.all([getNode(type, symbol), edgesFrom(type, symbol)]);
      const drivers = await Promise.all(
        edges.filter((e) => e.rel === "exposure" || e.rel === "resolves_on" || e.rel === "tracks").map(async (e) => {
          const d = await getNode(e.to.type, e.to.id);
          const basin = d?.props.basin ? ` (${d.props.basin} basin)` : "";
          return `${e.to.type}: ${d?.label ?? e.to.id}${basin}`;
        }),
      );
      return { symbol, label: node?.label ?? null, exposed_to: drivers };
    }),
  );
}

/** Regions and commodities the gate needs from day one; idempotent, never overwrites labels. */
export async function ensureBootstrap(): Promise<void> {
  const now = new Date().toISOString();
  const regions: [string, string, Basin][] = [
    ["texas", "Texas coast", "atlantic"],
    ["louisiana", "Louisiana coast", "atlantic"],
    ["us-gulf-coast", "US Gulf Coast", "atlantic"],
    ["florida", "Florida", "atlantic"],
    ["us-east-coast", "US East Coast", "atlantic"],
    ["caribbean", "Caribbean", "atlantic"],
    ["hawaii", "Hawaii", "pacific"],
    ["california", "California coast", "pacific"],
    ["mexico-pacific-coast", "Mexico Pacific coast", "pacific"],
    ["baja-california", "Baja California", "pacific"],
  ];
  const commodities: [string, string, string][] = [
    ["wti", "WTI crude (NYMEX CL)", "CL=F"],
    ["brent", "Brent crude (ICE)", "BZ=F"],
    ["natural-gas", "Henry Hub natural gas", "NG=F"],
    ["gold", "Gold", "GC=F"],
  ];
  for (const [id, label, basin] of regions) {
    if (!(await getNode("region", id))) {
      await upsertNode({ type: "region", id, label, props: { basin }, source: "bootstrap", confidence: 1, observed_at: now, expires_at: null });
    }
  }
  for (const [id, label, quote] of commodities) {
    if (!(await getNode("commodity", id))) {
      await upsertNode({ type: "commodity", id, label, props: { quote_symbol: quote }, source: "bootstrap", confidence: 1, observed_at: now, expires_at: null });
    }
  }
}
