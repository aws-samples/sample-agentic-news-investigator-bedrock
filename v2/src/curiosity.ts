// SPDX-License-Identifier: MIT-0
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { config } from "./config.js";
import { ddb, listPositions } from "./ledger.js";
import { putAudit } from "./audit.js";
import { checkBudget } from "./budget.js";
import { investigateAndAct } from "./pipeline.js";
import { priceDeviation } from "./gate.js";
import { gateDeps } from "./worldwrite.js";
import { worldModelFor, slug, type WorldModelView } from "./world.js";
import type { WebSearch } from "./websearch.js";
import type { NewsItem } from "./types.js";

/**
 * The curiosity loop: the world model asks the agent a question the news feed
 * never would. Every hour it looks for (1) price facts contradicted by the live
 * quote — the "WTI at $93" that was Brent; (2) held instruments nothing in the
 * model explains; (3) expired facts and links on the drivers of held positions;
 * (4) a book with no positions at all, which the first three cannot see because
 * each of them starts from one.
 *
 * (4) exists because an empty book is self-reinforcing. Triage judges materiality
 * partly in the light of what is held, so an arm holding nothing scores the same
 * story far lower: replaying 12 archived bodies through one unchanged prompt, an
 * empty held_positions gave mean materiality 0.30 and cleared the gate once,
 * while the same twelve with a three-position book gave 0.48 and cleared it seven
 * times — storm advisories moved 0.15-0.25 to 0.45-0.72 on identical text. No
 * position also means nothing ever sets touches_positions, so every event faces
 * the higher threshold as well. Triage therefore cannot bootstrap an arm out of
 * an empty book; the first question has to come from somewhere else, and this is
 * it. v3 sat at exactly $100,000.00 for its first day for that reason.
 * The worst one becomes an investigation (trigger "curiosity"), with a per-
 * subject cooldown so the same question is not asked every hour.
 */

export interface Issue {
  kind: "contradiction" | "unmodelled" | "stale" | "idle";
  subject: string;
  severity: number;
  detail: string;
  symbols: string[];
}

const PRICE_KEYS = new Set(["price", "level", "spot", "last", "close", "quote"]);
const CONTRADICTION_TOLERANCE = 0.03;

/** What the agent is asked to do about a correction, and about an empty book. */
const CORRECTION_NOTE =
  "This is the world model asking, not news. Verify the flagged item against live sources " +
  "(resolve_instrument, web_search), correct the model with record_fact / link_exposure, then " +
  "re-underwrite the exposed positions against the corrected facts. Hold unless the correction " +
  "changes a thesis; say explicitly what the model got wrong and what you fixed.";
const IDLE_NOTE =
  "This is the world model asking, not news. This arm holds nothing, so there is no thesis to " +
  "re-underwrite and nothing flagged to correct. Establish what is tradeable right now: read the " +
  "world model, resolve the instruments and contracts it names, check them against live quotes, and " +
  "either open the one exposure the evidence supports or record why the market offers none. Do not " +
  "manufacture a trade to fill the book — a documented \"nothing worth owning\" is a correct answer " +
  "and is scored as one.";

export async function findIssues(
  view: WorldModelView,
  livePrice: (symbol: string) => Promise<number | null>,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const checked = new Set<string>();
  for (const p of view.positions) {
    const type = p.symbol.includes(":") ? "contract" : "instrument";
    const subjects = [
      { type, id: p.symbol, label: p.symbol, props: p.props, facts: p.facts },
      ...p.exposures.map((x) => x.driver),
    ];
    for (const s of subjects) {
      for (const f of s.facts) {
        if (typeof f.value !== "number" || !PRICE_KEYS.has(f.key)) continue;
        const qs =
          (typeof s.props.quote_symbol === "string" && s.props.quote_symbol) ||
          (s.type === "instrument" || s.type === "contract" ? s.id : null);
        if (!qs) continue;
        const key = `${s.type}:${s.id}#${f.key}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const live = await livePrice(qs);
        if (live !== null && priceDeviation(f.value, live) > CONTRADICTION_TOLERANCE) {
          issues.push({
            kind: "contradiction",
            subject: key,
            severity: 3,
            detail: `${s.label}.${f.key} is recorded as ${f.value}${f.unit ? ` ${f.unit}` : ""} (as of ${f.as_of}, ${f.source}) but the live quote for ${qs} is ${live}`,
            symbols: [p.symbol],
          });
        }
      }
    }
    if (p.exposures.length === 0) {
      issues.push({ kind: "unmodelled", subject: p.symbol, severity: 2, detail: `nothing in the world model explains what moves ${p.symbol}; establish its drivers and resolution rule`, symbols: [p.symbol] });
    }
    for (const x of p.exposures) {
      if (x.stale) issues.push({ kind: "stale", subject: `${x.driver.type}:${x.driver.id}`, severity: 1, detail: `the exposure link ${p.symbol} → ${x.driver.label} has expired; does it still hold?`, symbols: [p.symbol] });
      for (const f of x.driver.facts) {
        if (f.stale) issues.push({ kind: "stale", subject: `${x.driver.type}:${x.driver.id}#${f.key}`, severity: 1, detail: `${x.driver.label}.${f.key} (${f.value}) is stale since ${f.as_of}; refresh it`, symbols: [p.symbol] });
      }
    }
  }
  // The fourth check, and the only one that does not start from a position: an
  // arm holding nothing has no exposure to the market it is supposed to be
  // trading, which is itself a state worth one investigation.
  if (view.positions.length === 0) {
    issues.push({
      kind: "idle",
      subject: "book:empty",
      severity: 2,
      detail:
        "this arm holds nothing at all, so nothing in the world model is anchored to the book; " +
        "establish what the model already knows that is tradeable now, and either open the one " +
        "exposure the evidence supports or record why the market offers none",
      symbols: [],
    });
  }
  return issues;
}

/** Highest severity first; subjects under cooldown are skipped. Pure. */
export function pickIssue(issues: Issue[], cooledUntil: Map<string, number>, nowMs: number): Issue | null {
  const live = issues.filter((i) => (cooledUntil.get(i.subject) ?? 0) <= nowMs);
  live.sort((a, b) => b.severity - a.severity || a.subject.localeCompare(b.subject));
  return live[0] ?? null;
}

const stateKey = (subject: string) => ({ pk: "STATE", sk: `CURIOSITY#${subject}` });

async function cooledUntil(subjects: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    subjects.map(async (s) => {
      const r = await ddb.send(new GetCommand({ TableName: config.table, Key: stateKey(s) }));
      if (r.Item?.until) out.set(s, Date.parse(String(r.Item.until)));
    }),
  );
  return out;
}

async function setCooldown(subject: string): Promise<void> {
  const until = new Date(Date.now() + config.curiosityCooldownHours * 3_600_000).toISOString();
  await ddb.send(new PutCommand({ TableName: config.table, Item: { ...stateKey(subject), until, ttl: Math.floor(Date.now() / 1000) + 30 * 86400 } }));
}

let lastRefusalAudit = 0;

export async function curiosityPass(web: WebSearch | null): Promise<void> {
  const positions = await listPositions();
  // An empty book is not a reason to skip: it is issue (4) above.
  const symbols = positions.map((p) => p.symbol);
  const view = await worldModelFor(symbols);
  const issues = await findIssues(view, gateDeps.livePrice);
  if (issues.length === 0) return;
  const cool = await cooledUntil([...new Set(issues.map((i) => i.subject))]);
  const issue = pickIssue(issues, cool, Date.now());
  if (!issue) return;

  const budget = await checkBudget({ priority: true });
  if (!budget.allowed) {
    console.warn(`[curiosity] skipping (${issue.kind} ${issue.subject}): ${budget.reason}`);
    if (Date.now() - lastRefusalAudit > 3_600_000) {
      lastRefusalAudit = Date.now();
      await putAudit(`curiosity-${slug(issue.subject)}-${Date.now()}`, "v2-skipped", { reason: budget.reason, trigger: "curiosity", headline: `World model check: ${issue.detail}` }).catch(() => {});
    }
    return;
  }
  const now = new Date().toISOString();
  const id = `curiosity-${slug(issue.subject)}-${Date.now()}`;
  const item: NewsItem = {
    id,
    source_family: "curiosity",
    source_id: "world-model",
    published_at: now,
    ingested_at: now,
    headline: `World model check (${issue.kind}): ${issue.detail}`.slice(0, 300),
    summary: JSON.stringify({
      issue,
      positions_exposed: issue.symbols,
      note: issue.kind === "idle" ? IDLE_NOTE : CORRECTION_NOTE,
    }),
    url: "",
    tickers_hint: issue.symbols,
    asset_class_hint: null,
  };
  await setCooldown(issue.subject);
  await putAudit(id, "v3-curiosity", { issue }).catch(() => {});
  console.log(`[curiosity] ${issue.kind} on ${issue.subject}: investigating`);
  await investigateAndAct(item, [`Verify and correct: ${issue.detail}`], web);
}
