// SPDX-License-Identifier: MIT-0
/**
 * Amazon Bedrock Guardrails for the agent arms: the pure parts. Nothing in here
 * touches AWS, so tests import it freely; the one network call (ApplyGuardrail
 * over tool output) lives in `guardrail-runtime.ts`.
 *
 * Off unless V2_GUARDRAIL_ID and V2_GUARDRAIL_VERSION are both set (config.ts):
 * with them unset every helper below is the identity, so the live control arms
 * behave exactly as before. The guardrail itself is `infra/lib/guardrail.ts`.
 *
 * Three ways a model call is screened, chosen by what each path can do:
 *
 * 1. Direct Anthropic Messages calls on Bedrock (triage, filing summary, the v3
 *    link judge). The guardrail is named in two request headers, and only the
 *    untrusted text is evaluated: it is wrapped in
 *    `<amazon-bedrock-guardrails-guardContent_SUFFIX>` tags and the body names
 *    SUFFIX in `amazon-bedrock-guardrailConfig.tagSuffix`. Without tagSuffix
 *    Bedrock ignores the tags and evaluates nothing as guard content, so prompt
 *    attacks go unfiltered (observed). The suffix is random per call so a
 *    document cannot know it, and any guardrail tag text inside the untrusted
 *    text is neutralised before wrapping so it cannot close the tag early.
 * 2. The Agent SDK investigator. The SDK forwards `ANTHROPIC_CUSTOM_HEADERS`
 *    but cannot set a body field, so the guardrail sees the whole input on
 *    every turn (system prompt, book context and conversation so far). A
 *    block there is silent: result subtype `success`, $0, and the text is the
 *    blocked message, which is why blocks are detected by text.
 * 3. Tool output (`read_source`, `web_search`) never passes through a request
 *    the worker builds, so it is screened with the standalone ApplyGuardrail
 *    API before the agent sees it.
 *
 * A block returns `stop_reason: end_turn` with the configured blocked message
 * as the only text; the messages are distinctive tokens for that reason and
 * must equal `infra/lib/guardrail.ts` (the infra test checks).
 */
import { randomBytes } from "node:crypto";

export const BLOCKED_INPUT_MESSAGE = "FIN_GUARDRAIL_BLOCKED_INPUT";
export const BLOCKED_OUTPUT_MESSAGE = "FIN_GUARDRAIL_BLOCKED_OUTPUT";

export const HEADER_ID = "X-Amzn-Bedrock-GuardrailIdentifier";
export const HEADER_VERSION = "X-Amzn-Bedrock-GuardrailVersion";
/** Body field for the Anthropic Messages API on Bedrock (not in the SDK's types). */
export const BODY_FIELD = "amazon-bedrock-guardrailConfig";
/** Response field Bedrock adds when the guardrail acted. */
export const ACTION_FIELD = "amazon-bedrock-guardrailAction";

const TAG_STEM = "amazon-bedrock-guardrails";

export interface GuardrailRef {
  id: string;
  version: string;
}

/**
 * Both set → a guardrail; both unset → null (off). One without the other is a
 * misconfiguration and throws, so a worker never runs half-guarded believing
 * it is guarded.
 */
export function guardrailRef(id: string | undefined, version: string | undefined): GuardrailRef | null {
  const i = (id ?? "").trim();
  const v = (version ?? "").trim();
  if (!i && !v) return null;
  if (!i || !v) {
    throw new Error(
      "Bedrock guardrail: set both the guardrail id and its version (V2_GUARDRAIL_ID and " +
        "V2_GUARDRAIL_VERSION, from the FinStack outputs GuardrailId / GuardrailVersion), or neither.",
    );
  }
  return { id: i, version: v };
}

/** Request headers that name the guardrail; empty when off. */
export function guardrailHeaders(g: GuardrailRef | null | undefined): Record<string, string> {
  if (!g) return {};
  return { [HEADER_ID]: g.id, [HEADER_VERSION]: g.version };
}

/**
 * `ANTHROPIC_CUSTOM_HEADERS` for the Agent SDK's bundled runtime: one
 * `Name: value` per line. Merged after any value already in the environment.
 */
export function customHeadersEnv(g: GuardrailRef | null | undefined, existing?: string): string | undefined {
  const lines = Object.entries(guardrailHeaders(g)).map(([k, v]) => `${k}: ${v}`);
  if (!lines.length) return existing;
  return [existing?.trim(), ...lines].filter(Boolean).join("\n");
}

/** A fresh per-call tag suffix: alphanumeric, unguessable by the document. */
export function newTagSuffix(bytes: () => Buffer = () => randomBytes(9)): string {
  return bytes().toString("hex");
}

/**
 * Make any guardrail tag text inert. Every case-insensitive occurrence of the
 * tag stem (opening or closing tags, any suffix, with or without whitespace
 * inside the brackets) has its hyphens replaced, so no substring of the
 * untrusted text can be parsed as a guard-content tag. Text without the stem
 * is returned unchanged.
 */
export function escapeGuardTags(text: string): string {
  return text.replace(/amazon\s*-\s*bedrock\s*-\s*guardrails/gi, (m) => m.replace(/-/g, "_"));
}

export function guardContent(text: string, suffix: string): string {
  const tag = `${TAG_STEM}-guardContent_${suffix}`;
  return `<${tag}>${escapeGuardTags(text)}</${tag}>`;
}

/**
 * A guarded call's shape: wrap untrusted text with `tag()`, then pass `body()`
 * and `headers` to `messages.create`. When off, `tag` is the identity, `body`
 * returns the params untouched and `headers` is empty, so the request is
 * byte-identical to an unguarded one.
 */
export interface GuardedCall {
  active: boolean;
  tag(untrusted: string): string;
  body<T extends object>(params: T): T;
  headers: Record<string, string>;
}

export function guardedCall(g: GuardrailRef | null | undefined, suffix = g ? newTagSuffix() : ""): GuardedCall {
  if (!g) {
    return { active: false, tag: (t) => t, body: (p) => p, headers: {} };
  }
  return {
    active: true,
    tag: (t) => guardContent(t, suffix),
    body: (p) => ({ ...p, [BODY_FIELD]: { tagSuffix: suffix } }),
    headers: guardrailHeaders(g),
  };
}

/** True when the text is exactly one of the guardrail's blocked messages. */
export function isBlockedText(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t === BLOCKED_INPUT_MESSAGE || t === BLOCKED_OUTPUT_MESSAGE;
}

/** Which side blocked, or null. */
export function blockedSide(text: string | null | undefined): "input" | "output" | null {
  const t = (text ?? "").trim();
  if (t === BLOCKED_INPUT_MESSAGE) return "input";
  if (t === BLOCKED_OUTPUT_MESSAGE) return "output";
  return null;
}

/** Did the guardrail act on this Messages response? */
export function messageIntervened(msg: unknown): boolean {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as { content?: unknown; [k: string]: unknown };
  if (m[ACTION_FIELD] === "INTERVENED") return true;
  const blocks = Array.isArray(m.content) ? m.content : [];
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => !!b && (b as { type?: string }).type === "text")
    .map((b) => b.text)
    .join("");
  return isBlockedText(text);
}

/**
 * Did the guardrail block an Agent SDK run? Checks the final result text and
 * every assistant text block in the transcript (a block mid-run ends that turn
 * with the blocked message as its text).
 */
export function agentRunIntervened(finalText: string | null | undefined, transcript: readonly unknown[]): boolean {
  if (isBlockedText(finalText)) return true;
  for (const m of transcript) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { type?: string; message?: { content?: unknown } };
    if (msg.type !== "assistant") continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && typeof b === "object" && (b as { type?: string }).type === "text" && isBlockedText((b as { text?: string }).text)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------- ApplyGuardrail over tool output ----------------

/**
 * Characters per ApplyGuardrail request. Billing is per text unit of up to
 * 1,000 characters; the default us-east-1 quotas are 200 content-filter text
 * units per second with a burst of 1,000, so a 25-unit request is far inside
 * both. The docs give no smaller per-request cap for text.
 */
export const SCREEN_CHUNK_CHARS = 25_000;
/** Chunks overlap so an injection split across a boundary is seen whole by one. */
export const SCREEN_OVERLAP_CHARS = 1_000;
/**
 * At most this many chunks per tool result (about 100 text units, roughly
 * $0.015 of content filtering at list price). `read_source` caps its text at
 * 24,000 characters, so one or two chunks is normal; anything longer is cut
 * to what was screened rather than passed through unscreened.
 */
export const SCREEN_MAX_CHUNKS = 4;

export interface ScreenPlan {
  chunks: string[];
  /** Characters of the input the chunks cover; the rest is dropped. */
  coveredChars: number;
  truncated: boolean;
}

export function planScreen(
  text: string,
  size = SCREEN_CHUNK_CHARS,
  overlap = SCREEN_OVERLAP_CHARS,
  maxChunks = SCREEN_MAX_CHUNKS,
): ScreenPlan {
  if (size <= overlap) throw new Error("chunk size must exceed the overlap");
  if (!text) return { chunks: [], coveredChars: 0, truncated: false };
  const chunks: string[] = [];
  let start = 0;
  let end = 0;
  while (chunks.length < maxChunks && end < text.length) {
    end = Math.min(text.length, start + size);
    chunks.push(text.slice(start, end));
    start = end - overlap;
  }
  return { chunks, coveredChars: end, truncated: end < text.length };
}

/** The ApplyGuardrail response fields we read (structural, so tests need no SDK). */
export interface ApplyGuardrailLike {
  action?: string;
  assessments?: object[];
}

/** Policy names that fired, for the log line and the notice (no content echoed). */
export function interventionReasons(out: ApplyGuardrailLike): string[] {
  const reasons = new Set<string>();
  for (const a of (out.assessments ?? []) as Array<Record<string, unknown>>) {
    const content = a.contentPolicy as { filters?: Array<{ type?: string; action?: string }> } | undefined;
    for (const f of content?.filters ?? []) if (f.action === "BLOCKED") reasons.add(String(f.type ?? "CONTENT"));
    const words = a.wordPolicy as { customWords?: Array<{ action?: string }>; managedWordLists?: Array<{ type?: string; action?: string }> } | undefined;
    for (const w of words?.managedWordLists ?? []) if (w.action === "BLOCKED") reasons.add(String(w.type ?? "WORDS"));
    if ((words?.customWords ?? []).some((w) => w.action === "BLOCKED")) reasons.add("CUSTOM_WORDS");
    const topics = a.topicPolicy as { topics?: Array<{ name?: string; action?: string }> } | undefined;
    for (const t of topics?.topics ?? []) if (t.action === "BLOCKED") reasons.add(`TOPIC:${t.name ?? "?"}`);
    const pii = a.sensitiveInformationPolicy as { piiEntities?: Array<{ type?: string; action?: string }> } | undefined;
    for (const p of pii?.piiEntities ?? []) if (p.action === "BLOCKED") reasons.add(`PII:${p.type ?? "?"}`);
  }
  return [...reasons].sort();
}

export function applyIntervened(out: ApplyGuardrailLike): boolean {
  return out.action === "GUARDRAIL_INTERVENED";
}

/** What the agent reads instead of a blocked tool result. */
export function withheldNotice(tool: string, reasons: string[]): string {
  const why = reasons.length ? ` (${reasons.join(", ")})` : "";
  return (
    `[${tool} result withheld by the content guardrail${why}. The source contained text the ` +
    `guardrail classifies as a prompt attack or disallowed content. Treat this source as ` +
    `unavailable; do not retry it.]`
  );
}

/** Appended when a result was longer than the screening bound and was cut. */
export function truncationNotice(coveredChars: number, totalChars: number): string {
  return `\n[truncated to the ${coveredChars} of ${totalChars} characters the content guardrail screened]`;
}
