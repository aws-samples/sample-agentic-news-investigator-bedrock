// SPDX-License-Identifier: MIT-0
/**
 * The guardrail's runtime half: which guardrail is configured, and the
 * ApplyGuardrail screen over tool output. The pure parts are `guardrail.ts`.
 */
import { ApplyGuardrailCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config.js";
import {
  applyIntervened,
  interventionReasons,
  planScreen,
  truncationNotice,
  withheldNotice,
  guardrailRef,
  type ApplyGuardrailLike,
  type GuardrailRef,
} from "./guardrail.js";

let configured: GuardrailRef | null | undefined;

/**
 * The guardrail in effect for a call: an explicit per-run choice wins (`null`
 * = off, which is how the bench keeps non-guardrail variants unguarded), else
 * V2_GUARDRAIL_ID / V2_GUARDRAIL_VERSION.
 */
export function activeGuardrail(override?: GuardrailRef | null): GuardrailRef | null {
  if (override !== undefined) return override;
  if (configured === undefined) configured = guardrailRef(config.guardrailId, config.guardrailVersion);
  return configured;
}

export type ApplyFn = (g: GuardrailRef, text: string) => Promise<ApplyGuardrailLike>;

let client: BedrockRuntimeClient | undefined;
const applyViaSdk: ApplyFn = async (g, text) => {
  client ??= new BedrockRuntimeClient({ region: config.region, maxAttempts: 2 });
  return client.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: g.id,
      guardrailVersion: g.version,
      source: "INPUT",
      content: [{ text: { text } }],
    }),
  );
};

export interface ScreenResult {
  /** What the agent reads: the original, a truncated original, or a withheld notice. */
  text: string;
  intervened: boolean;
  reasons: string[];
  /** True when screening failed or timed out and the text passed unscreened. */
  failedOpen: boolean;
}

/**
 * Screen one tool result with ApplyGuardrail (source INPUT: it is about to
 * become model input). Chunks run concurrently under one deadline.
 *
 * Fails OPEN: on any error or timeout the text passes unscreened and the
 * failure is logged. Availability over screening on purpose: the investigator
 * prompt's external-content-is-data rule (threat model M02) is the primary
 * control and the guardrail is the second layer, so a Bedrock hiccup must not
 * blind the agent mid-investigation.
 */
export async function screenToolOutput(
  tool: string,
  text: string,
  g: GuardrailRef | null,
  opts: { apply?: ApplyFn; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<ScreenResult> {
  const pass: ScreenResult = { text, intervened: false, reasons: [], failedOpen: false };
  if (!g || !text) return pass;
  const log = opts.log ?? ((l: string) => console.warn(l));
  const apply = opts.apply ?? applyViaSdk;
  const timeoutMs = opts.timeoutMs ?? config.guardrailScreenTimeoutMs;
  const plan = planScreen(text);
  let timer: NodeJS.Timeout | undefined;
  try {
    const outs = await Promise.race([
      Promise.all(plan.chunks.map((c) => apply(g, c))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    const hit = outs.filter(applyIntervened);
    if (hit.length) {
      const reasons = [...new Set(hit.flatMap(interventionReasons))].sort();
      log(`[guardrail] ${tool} result withheld (${reasons.join(", ") || "intervened"}), ${text.length} chars`);
      return { text: withheldNotice(tool, reasons), intervened: true, reasons, failedOpen: false };
    }
    if (plan.truncated) {
      log(`[guardrail] ${tool} result cut to the screened ${plan.coveredChars} of ${text.length} chars`);
      return { ...pass, text: text.slice(0, plan.coveredChars) + truncationNotice(plan.coveredChars, text.length) };
    }
    return pass;
  } catch (e) {
    log(`[guardrail] ${tool} screen failed open: ${(e as Error).message}`);
    return { ...pass, failedOpen: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
