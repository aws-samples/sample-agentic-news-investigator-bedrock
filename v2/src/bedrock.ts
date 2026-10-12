// SPDX-License-Identifier: MIT-0
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { config } from "./config.js";
import { normalizeUsage, priceUsage } from "./pricing.js";

/** Shared Bedrock client for the cheap specialist calls (triage, extraction). */
export const bedrock = new AnthropicBedrock({ awsRegion: config.region });

type StreamParams = Parameters<typeof bedrock.messages.stream>[0];
export type StreamedMessage = Awaited<
  ReturnType<ReturnType<typeof bedrock.messages.stream>["finalMessage"]>
>;

/**
 * One long-form completion, streamed, with a hard deadline and progress in the
 * log. A non-streaming `messages.create` sits silent until the whole reply is
 * ready, times out at the SDK default of 10 minutes, and is then retried twice
 * more by the SDK itself with nothing in the log — the 2026-09-02 18:03 hand-run
 * of the daily letter took 18 minutes for a call that had taken two an hour
 * earlier, almost certainly one abandoned (and billed) generation plus one
 * successful one. Streaming keeps the connection alive while the model thinks
 * and writes, so a slow generation finishes instead of being abandoned; the SDK
 * retry is disabled so the caller's own retry (which logs) is the only one; and
 * the deadline bounds a genuine stall.
 */
export async function streamMessage(
  params: StreamParams,
  opts: { label: string; deadlineMs: number; progressEveryMs?: number },
): Promise<StreamedMessage> {
  const started = Date.now();
  const secs = () => Math.round((Date.now() - started) / 1000);
  console.log(`[${opts.label}] request sent (max_tokens ${params.max_tokens})`);
  const stream = bedrock.messages.stream(params, { maxRetries: 0 });
  let chars = 0;
  let lastLog = started;
  stream.on("text", (t) => {
    chars += t.length;
    if (Date.now() - lastLog >= (opts.progressEveryMs ?? 60_000)) {
      lastLog = Date.now();
      console.log(`[${opts.label}] streaming: ${chars} chars after ${secs()}s`);
    }
  });
  const timer = setTimeout(() => stream.abort(), opts.deadlineMs);
  try {
    const msg = await stream.finalMessage();
    // Usage as the API reported it, priced at the requested model's rates
    // (pricing.ts) so every long completion says what it cost in the log.
    const u = normalizeUsage(msg.usage);
    const priced = priceUsage(String(params.model), u);
    console.log(
      `[${opts.label}] complete: ${chars} chars in ${secs()}s, stop_reason=${msg.stop_reason}; ` +
        `${u.input_tokens} in / ${u.output_tokens} out / ${u.cache_read_input_tokens} cache read ` +
        `≈ $${priced.usd.toFixed(2)}${priced.pricedWithFallback ? " (fallback rate: model not in pricing table)" : ""}`,
    );
    return msg;
  } catch (e) {
    if (Date.now() - started >= opts.deadlineMs) {
      throw new Error(
        `${opts.label}: no complete response within ${Math.round(opts.deadlineMs / 1000)}s (${chars} chars streamed)`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

