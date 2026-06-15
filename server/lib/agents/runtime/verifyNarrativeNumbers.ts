/**
 * ============================================================================
 * verifyNarrativeNumbers.ts — catch numbers in the written answer that aren't
 * actually backed by any chart
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The narrator writes a prose answer full of figures ("sales fell 17%",
 *   "₹4.2 lakh"). This file pulls every numeric claim out of that prose
 *   (percentages, currency, magnitudes like 1.2M, plain decimals) and checks
 *   whether each one actually appears — within a ±2% tolerance — somewhere in
 *   the charts that ship with the answer (their underlying data rows, their
 *   `keyInsight` text, or their axis domains). Claims with no match are returned
 *   as `unsupported`.
 *
 * WHY IT MATTERS
 *   This is a hallucination guard: it surfaces fabricated figures (a 17% drop
 *   that appears in no chart) so the verifier can flag or revise them before the
 *   user sees them. It is a SOFT check — it only reports; the verifier still
 *   decides whether to revise the narrative or pass it through. When there is no
 *   chart data to anchor against it reports everything as supported (no false
 *   positives) and lets other checks rule.
 *
 * KEY PIECES
 *   - extractNumbersFromNarrative — regex out numeric claims (skips years + tiny ints to cut noise)
 *   - verifyNarrativeAgainstCharts — main: split claims into supported / unsupported
 *   - VerifyResult / ExtractedNumber — the returned shapes
 *
 * HOW IT CONNECTS
 *   Pure logic, no I/O — importable anywhere. Consumes `ChartSpec[]` from
 *   `../../../shared/schema.js`. Called by the verifier stage of the agent loop.
 */

import type { ChartSpec } from "../../../shared/schema.js";

export interface ExtractedNumber {
  /** Cleaned numeric value (e.g. "23.4%" → 23.4). */
  value: number;
  /** Original textual form so the verifier can name the offending phrase. */
  raw: string;
  /** Character index in the source narrative — handy for highlighting. */
  index: number;
}

export interface VerifyResult {
  totalClaims: number;
  supported: ExtractedNumber[];
  unsupported: ExtractedNumber[];
}

const DEFAULT_TOLERANCE = 0.02;
const MAX_VALUES_PER_CHART = 1000;

/**
 * Pull every plausible numeric claim out of `text`. Captures:
 *   - Plain integers / decimals: 1234, 1,234.5
 *   - Percentages: 23%, 23.4%, -5.2%
 *   - Currency: $1.2M, ₹4.2 lakh, €12,345.67
 *
 * Skips:
 *   - 4-digit years (1990–2099) — they're rarely the numeric claim under audit
 *   - Bare integers ≤ 5 — too noisy ("3 sentences", "2 segments")
 */
export function extractNumbersFromNarrative(text: string): ExtractedNumber[] {
  if (!text) return [];
  const out: ExtractedNumber[] = [];
  // Order matters — currency/percent regex run first so the bare-number regex
  // doesn't claim them. We track consumed ranges to avoid double-extraction.
  const consumed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) =>
    consumed.some(([s, e]) => start < e && end > s);

  const push = (raw: string, value: number, index: number) => {
    if (!Number.isFinite(value)) return;
    if (overlaps(index, index + raw.length)) return;
    consumed.push([index, index + raw.length]);
    out.push({ value, raw, index });
  };

  // Currency with magnitude suffix (M, B, K, lakh, crore)
  const currencyRe = /([\$€£₹])\s*(-?[\d,]+(?:\.\d+)?)\s*(M|B|K|lakh|crore|million|billion|thousand)?/gi;
  for (const m of text.matchAll(currencyRe)) {
    if (m.index == null) continue;
    const numeric = Number(m[2]!.replace(/,/g, ""));
    const mult = unitMultiplier(m[3]);
    push(m[0], numeric * mult, m.index);
  }

  // Percentages
  const percentRe = /(-?[\d,]+(?:\.\d+)?)\s*%/g;
  for (const m of text.matchAll(percentRe)) {
    if (m.index == null) continue;
    const v = Number(m[1]!.replace(/,/g, ""));
    push(m[0], v, m.index);
  }

  // Magnitude-suffixed bare numbers ("12.3M sales", "4.2 lakh")
  const magRe = /(-?[\d,]+(?:\.\d+)?)\s*(M|B|K|lakh|crore|million|billion|thousand)\b/gi;
  for (const m of text.matchAll(magRe)) {
    if (m.index == null) continue;
    const v = Number(m[1]!.replace(/,/g, "")) * unitMultiplier(m[2]);
    push(m[0], v, m.index);
  }

  // Bare integers / decimals
  const bareRe = /(?<![\d\.])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![\d\.%])/g;
  for (const m of text.matchAll(bareRe)) {
    if (m.index == null) continue;
    const v = Number(m[1]!.replace(/,/g, ""));
    if (!Number.isFinite(v)) continue;
    if (Math.abs(v) <= 5) continue; // skip noisy "3 sentences", etc.
    if (Number.isInteger(v) && v >= 1990 && v <= 2099) continue; // year filter
    push(m[1]!, v, m.index);
  }

  return out.sort((a, b) => a.index - b.index);
}

function unitMultiplier(unit?: string | null): number {
  if (!unit) return 1;
  const u = unit.toLowerCase();
  if (u === "k" || u === "thousand") return 1_000;
  if (u === "m" || u === "million") return 1_000_000;
  if (u === "b" || u === "billion") return 1_000_000_000;
  if (u === "lakh") return 100_000;
  if (u === "crore") return 10_000_000;
  return 1;
}

function chartValuePool(charts: ChartSpec[]): number[] {
  const pool: number[] = [];
  for (const c of charts) {
    if (c.keyInsight) {
      // Recurse — the chart's keyInsight string may itself cite numbers, and a
      // narrative claim that matches the keyInsight is by construction supported.
      for (const ext of extractNumbersFromNarrative(c.keyInsight)) {
        pool.push(ext.value);
      }
    }
    const data = (c as { data?: Array<Record<string, unknown>> }).data;
    if (Array.isArray(data)) {
      let added = 0;
      for (const row of data) {
        for (const v of Object.values(row ?? {})) {
          if (typeof v === "number" && Number.isFinite(v)) {
            pool.push(v);
            added++;
            if (added >= MAX_VALUES_PER_CHART) break;
          }
        }
        if (added >= MAX_VALUES_PER_CHART) break;
      }
    }
    // Trend lines / domain bounds may hold values too.
    if (Array.isArray(c.xDomain)) for (const v of c.xDomain) if (typeof v === "number") pool.push(v);
    if (Array.isArray(c.yDomain)) for (const v of c.yDomain) if (typeof v === "number") pool.push(v);
  }
  return pool;
}

/** Match `claim` to any pool entry within ±tolerance (default 2%). */
function isSupported(claim: number, pool: number[], tolerance: number): boolean {
  for (const v of pool) {
    if (v === 0) {
      if (Math.abs(claim) < 1e-9) return true;
      continue;
    }
    const rel = Math.abs((v - claim) / Math.abs(v));
    if (rel <= tolerance) return true;
  }
  return false;
}

/**
 * Verify every numeric claim in `narrative` against `charts`. Returns split
 * lists of supported + unsupported claims. The verifier is expected to surface
 * the unsupported list as issues.
 */
export function verifyNarrativeAgainstCharts(
  narrative: string,
  charts: ChartSpec[],
  tolerance: number = DEFAULT_TOLERANCE
): VerifyResult {
  const claims = extractNumbersFromNarrative(narrative);
  if (claims.length === 0) {
    return { totalClaims: 0, supported: [], unsupported: [] };
  }
  const pool = chartValuePool(charts);
  // When there's no chart data to anchor against, we can't verify — return
  // every claim as "supported" (no false positives) and let other checks rule.
  if (pool.length === 0) {
    return { totalClaims: claims.length, supported: claims, unsupported: [] };
  }
  const supported: ExtractedNumber[] = [];
  const unsupported: ExtractedNumber[] = [];
  for (const c of claims) {
    if (isSupported(c.value, pool, tolerance)) supported.push(c);
    else unsupported.push(c);
  }
  return { totalClaims: claims.length, supported, unsupported };
}
