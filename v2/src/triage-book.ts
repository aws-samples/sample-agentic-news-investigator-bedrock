// SPDX-License-Identifier: MIT-0
/**
 * What triage is told about the book (V2_TRIAGE_BOOK). Before, held_positions was the bare symbol
 * list, dust included (185 rows in v2 on 2026-10-26): no side, size, kind or reason, so triage
 * could tell that a story touched a symbol but not whether it mattered to the book or which way.
 * Now: positions above the dust line, largest first, capped, each with a one-line thesis. Pure.
 */
import { isDust, positionValueUsd, type PositionLike } from "./dust.js";

export interface TriagePosition {
  symbol: string;
  kind: string;
  side: "long" | "short";
  value_usd: number;
  thesis: string | null;
}

export function triageBook(
  positions: (PositionLike & { symbol: string; kind?: string })[],
  thesisOf: (symbol: string) => string | undefined,
  opts: { max?: number; thesisChars?: number; dustUsd?: number } = {},
): TriagePosition[] {
  const max = opts.max ?? 40;
  const chars = opts.thesisChars ?? 140;
  return positions
    .filter((p) => p.qty !== 0 && !isDust(p, opts.dustUsd))
    .map((p) => ({ p, v: positionValueUsd(p) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, max)
    .map(({ p, v }) => {
      const t = thesisOf(p.symbol)?.replace(/\s+/g, " ").trim();
      return {
        symbol: p.symbol,
        kind: p.kind ?? "unknown",
        side: p.qty > 0 ? "long" : "short",
        value_usd: Math.round(v),
        thesis: t ? (t.length > chars ? t.slice(0, chars - 1) + "…" : t) : null,
      };
    });
}
