// SPDX-License-Identifier: MIT-0
import type { InstrumentKind, Quote, Resolution } from "../types.js";
import { config } from "../config.js";
import { yahooFxQuote, yahooEquityQuote, yahooCryptoQuote } from "./yahoo.js";
import { krakenFxQuote, krakenCryptoQuote } from "./kraken.js";
import { criptoyaQuote, criptoyaFiat } from "./criptoya.js";
import { coinbaseSpotQuote } from "./coinbase.js";
import { kalshiQuote, polymarketQuote, splitSide } from "./prediction.js";
import { disabledReason, sourceEnabled } from "../sources.js";

/**
 * The deterministic tradeability gate: the agent may propose ANY instrument,
 * but only symbols this resolver can price against a live public API exist
 * for execution. This is the "grounding" half of the design — the LLM never
 * invents a price.
 */

// ISO 4217 currency codes (active), for recognizing 6-letter FX pairs.
const ISO_CCY = new Set([
  "AED","AFN","ALL","AMD","ANG","AOA","ARS","AUD","AWG","AZN","BAM","BBD",
  "BDT","BGN","BHD","BIF","BMD","BND","BOB","BRL","BSD","BTN","BWP","BYN",
  "BZD","CAD","CDF","CHF","CLP","CNY","CNH","COP","CRC","CUP","CVE","CZK",
  "DJF","DKK","DOP","DZD","EGP","ERN","ETB","EUR","FJD","FKP","GBP","GEL",
  "GHS","GIP","GMD","GNF","GTQ","GYD","HKD","HNL","HTG","HUF","IDR","ILS",
  "INR","IQD","IRR","ISK","JMD","JOD","JPY","KES","KGS","KHR","KMF","KPW",
  "KRW","KWD","KYD","KZT","LAK","LBP","LKR","LRD","LSL","LYD","MAD","MDL",
  "MGA","MKD","MMK","MNT","MOP","MRU","MUR","MVR","MWK","MXN","MYR","MZN",
  "NAD","NGN","NIO","NOK","NPR","NZD","OMR","PAB","PEN","PGK","PHP","PKR",
  "PLN","PYG","QAR","RON","RSD","RUB","RWF","SAR","SBD","SCR","SDG","SEK",
  "SGD","SHP","SLE","SOS","SRD","SSP","STN","SYP","SZL","THB","TJS","TMT",
  "TND","TOP","TRY","TTD","TWD","TZS","UAH","UGX","USD","UYU","UZS","VES",
  "VND","VUV","WST","XAF","XCD","XOF","XPF","YER","ZAR","ZMW","ZWL",
]);

const KNOWN_CRYPTO = new Set([
  "BTC","ETH","SOL","XRP","ADA","DOGE","DOT","LINK","AVAX","LTC","BCH",
  "ATOM","UNI","XLM","ETC","NEAR","APT","ARB","OP","MATIC","POL","TON","SUI",
]);

/**
 * Currencies with a deep interbank spot market. For a pair of these, an
 * exchange book hundreds of bps wide is not the market, and a reference rate
 * with the standard 2 bps adverse fill is the honest simulation. Everything
 * else (NPR, BOB, ...) keeps today's semantics: a book if a venue has one,
 * otherwise an indicative reference the agent is told not to trade.
 */
export const LIQUID_FX = new Set([
  "USD", "EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "NZD", "SEK", "NOK", "DKK",
  "MXN", "SGD", "HKD", "CNH", "ZAR", "PLN",
]);

export function isLiquidFxPair(pair: string): boolean {
  return isFxPair(pair) && LIQUID_FX.has(pair.slice(0, 3)) && LIQUID_FX.has(pair.slice(3));
}

export function spreadBps(q: { bid?: number; ask?: number; price: number }): number | null {
  if (q.bid === undefined || q.ask === undefined || !(q.bid > 0) || !(q.ask > 0)) return null;
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? ((q.ask - q.bid) / mid) * 1e4 : null;
}

/**
 * Which FX quote to trust. Pure, so it is tested: `fetchReference` is only
 * called when the exchange book is missing or (for a liquid pair) too wide.
 */
export async function pickFxQuote(
  pair: string,
  exchange: Quote | null,
  fetchReference: () => Promise<Quote | null>,
  maxSpreadBps = config.fxMaxSpreadBps,
): Promise<{ quote: Quote; indicativeOnly: boolean; note?: string } | null> {
  const liquid = isLiquidFxPair(pair);
  const bps = exchange ? spreadBps(exchange) : null;
  if (exchange && bps !== null && (!liquid || bps <= maxSpreadBps)) {
    return { quote: exchange, indicativeOnly: false };
  }
  const ref = await fetchReference();
  if (ref) {
    if (liquid) {
      // Interbank reference for a major: tradeable at the standard 2 bps adverse fill.
      const note = exchange
        ? `${exchange.source} book ${bps!.toFixed(0)} bps wide — not the market for a major; using the interbank reference`
        : "interbank reference (no exchange book)";
      return { quote: { ...ref, source: `${ref.source} reference` }, indicativeOnly: false, note };
    }
    return { quote: ref, indicativeOnly: true };
  }
  if (exchange) return { quote: exchange, indicativeOnly: false };
  return null;
}
function predictionMissReason(symbol: string): string {
  const venues = [
    ...(sourceEnabled("kalshi") ? ["Kalshi"] : []),
    ...(sourceEnabled("polymarket") ? ["Polymarket"] : []),
  ];
  if (venues.length === 0) return `${symbol}: no prediction-market source is enabled in this deployment (V2_ENABLE_SOURCES)`;
  const off = venues.length === 1 ? ` (${venues[0] === "Kalshi" ? "Polymarket" : "Kalshi"} is not enabled: V2_ENABLE_SOURCES)` : "";
  return `${symbol}: not found on ${venues.join(" or ")}${off}`;
}

export function isFxPair(symbol: string): boolean {
  if (!/^[A-Z]{6}$/.test(symbol)) return false;
  return ISO_CCY.has(symbol.slice(0, 3)) && ISO_CCY.has(symbol.slice(3));
}

export function inferKind(symbol: string): InstrumentKind {
  if (criptoyaFiat(symbol)) return "parallel_fx";
  if (splitSide(symbol)) return "prediction";
  if (isFxPair(symbol)) return "fx";
  if (KNOWN_CRYPTO.has(symbol)) return "crypto";
  return "equity";
}

function normalize(raw: string): string {
  // Accept EUR/USD, eurusd, EUR-USD from the model; canonical is EURUSD.
  const cleaned = raw.trim().replace(/[\s/\-_]/g, "");
  // Prediction symbols keep their case-sensitive slug/ticker.
  if (splitSide(raw.trim())) return raw.trim();
  // Futures (CL=F, ES=F) and exchange-suffixed listings (7203.T, VOD.L) are Yahoo symbols.
  if (/^[A-Za-z0-9]{1,8}=F$/.test(cleaned) || /^[A-Za-z0-9]{1,10}\.[A-Za-z]{1,3}$/.test(cleaned)) {
    return cleaned.toUpperCase();
  }
  return /^[A-Za-z]{6}$/.test(cleaned) || /^[A-Za-z]{3,10}$/.test(cleaned)
    ? cleaned.toUpperCase()
    : raw.trim();
}

export async function resolve(
  rawSymbol: string,
  kindHint?: InstrumentKind | "auto",
): Promise<Resolution> {
  const symbol = normalize(rawSymbol);
  const kind: InstrumentKind =
    kindHint && kindHint !== "auto" ? kindHint : inferKind(symbol);

  let quote: Quote | null = null;
  let fxIndicative: boolean | null = null;
  let fxNote: string | undefined;
  switch (kind) {
    case "parallel_fx":
      quote = await criptoyaQuote(symbol);
      if (!quote) {
        return {
          ok: false,
          reason:
            `${symbol}: no live parallel-rate quote (need >=2 fresh venues on ` +
            `CriptoYa). The currency may have no legal/liquid USDT market.`,
        };
      }
      break;
    case "fx": {
      if (!isFxPair(symbol)) {
        return { ok: false, reason: `${symbol}: not a recognizable ISO-4217 pair` };
      }
      const picked = await pickFxQuote(symbol, await krakenFxQuote(symbol), () => yahooFxQuote(symbol));
      if (!picked) {
        return {
          ok: false,
          reason: sourceEnabled("yahoo")
            ? `${symbol}: no FX quote from Kraken or Yahoo`
            : `${symbol}: no FX quote from Kraken (Yahoo, the reference for other pairs, is not enabled: V2_ENABLE_SOURCES)`,
        };
      }
      quote = picked.quote;
      fxIndicative = picked.indicativeOnly;
      fxNote = picked.note;
      break;
    }
    case "crypto":
      // Books first (Kraken, Coinbase); then Yahoo's reference for the long tail of coins
      // that trade on venues we do not query (MANTRA/OM lived only on Binance/OKX/Bybit).
      quote =
        (await krakenCryptoQuote(symbol)) ??
        (await coinbaseSpotQuote(symbol)) ??
        (await yahooCryptoQuote(symbol));
      if (!quote) {
        return {
          ok: false,
          reason: `${symbol}: no crypto quote from ${["Kraken", ...(sourceEnabled("coinbase") ? ["Coinbase"] : []), ...(sourceEnabled("yahoo") ? ["Yahoo"] : [])].join(" or ")}${sourceEnabled("coinbase") && sourceEnabled("yahoo") ? "" : " (other sources are not enabled: V2_ENABLE_SOURCES)"}`,
        };
      }
      break;
    case "prediction": {
      const parts = splitSide(symbol);
      if (!parts) {
        return { ok: false, reason: `${symbol}: prediction symbols are <ticker-or-slug>:YES|NO` };
      }
      // Kalshi tickers are SCREAMING-KEBAB; Polymarket slugs lowercase.
      const kalshiFirst = parts.id === parts.id.toUpperCase();
      quote = kalshiFirst
        ? (await kalshiQuote(symbol)) ?? (await polymarketQuote(symbol))
        : (await polymarketQuote(symbol)) ?? (await kalshiQuote(symbol));
      if (!quote) {
        return {
          ok: false,
          reason: predictionMissReason(symbol),
        };
      }
      break;
    }
    case "equity":
      // Equities, ETFs, international listings and futures have no source but Yahoo.
      if (!sourceEnabled("yahoo")) return { ok: false, reason: disabledReason(symbol, "yahoo") };
      quote = await yahooEquityQuote(symbol);
      if (!quote) return { ok: false, reason: `${symbol}: no Yahoo quote` };
      break;
  }

  const hasBook =
    quote.bid !== undefined && quote.ask !== undefined && quote.bid > 0 && quote.ask > 0;
  return {
    ok: true,
    quote,
    meta: {
      hasBook,
      ageSecs: Math.max(0, Math.round((Date.now() - quote.asOfMs) / 1000)),
      indicativeOnly: fxIndicative ?? (quote.kind === "fx" && !hasBook),
      ...(fxNote ? { note: fxNote } : {}),
    },
  };
}
