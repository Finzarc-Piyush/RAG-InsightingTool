/**
 * ============================================================================
 * verifierCausalCheck.ts — the deterministic rail behind the hedged "why" lane
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The answer envelope carries an OPTIONAL `likelyDrivers[]` section — the
 *   quarantined, hedged "Why this might be happening" lane (W-SR1). This pure
 *   detector polices that lane and the measured layer so a plausible mechanism
 *   can never masquerade as a measured fact and a fabricated statistic can never
 *   ride inside an explanation. It runs BEFORE the contract grants the model
 *   permission to speculate (W-CP1) and before the advisory LLM verifier loosens
 *   (W-CP2), so there is no window where the model may speculate with no gate.
 *
 * THE FOUR PREDICATES
 *   1. HEDGED            — every likelyDrivers[].explanation must contain a term
 *                          from CAUSAL_HEDGE_TERMS (sharedPrompts.ts). A bare
 *                          causal assertion ("X caused Y") is a violation.
 *   2. NO-STAT-NUMBER    — an explanation may not carry a statistic-shaped number
 *                          (percent / decimal / multiplier / thousands / unit).
 *                          Numbers live in findings/magnitudes; a number inside a
 *                          mechanism reads as fabricated evidence. Ordinals and
 *                          plain category labels ("1st-class", "Pclass 3") are
 *                          fine — they are not statistics.
 *   3. DATA-GROUNDED     — a driver tagged basis="data" must actually name a real
 *                          dataset column (else its "measured" grounding is false
 *                          and it should be "general"/"domain"). Uses the dataset
 *                          column list, mirroring columnMatcher's intent.
 *   4. MEASURED-CLEAN    — the measured layer (body / findings / implications)
 *                          must stay causation-free; a causal connective there is
 *                          reported (info) for the LLM verifier (W-CP2) to act on.
 *
 *   The basis↔confidence coupling is NOT re-checked here — likelyDriverSchema
 *   already clamps it structurally at parse (W-SR1), so it is unbypassable
 *   upstream of this rail.
 *
 * HOW IT CONNECTS
 *   Pure module (no I/O). Reads NarratorOutput (narratorAgent.js) + the dataset
 *   column names. Mirrors verifierConfidenceCheck.ts in shape; the verifier
 *   stage short-circuits to `revise_narrative` when `shouldRevise` is true.
 */

import type { NarratorOutput } from "./narratorAgent.js";
import type { LikelyDriver } from "../../../shared/schema/charts.js";
import { CAUSAL_HEDGE_TERMS } from "./sharedPrompts.js";

export type CausalFlagSeverity = "info" | "warning" | "block";

export interface CausalClaimFlag {
  kind:
    | "driver_missing_hedge"
    | "driver_number_in_mechanism"
    | "driver_data_basis_ungrounded"
    | "measured_layer_causal_claim";
  severity: CausalFlagSeverity;
  /** The offending text (clipped) — suitable for a revise_narrative issue. */
  excerpt: string;
  message: string;
}

export interface CausalClaimReport {
  /** likelyDrivers explanations missing any hedge term. */
  unhedgedDrivers: string[];
  /** likelyDrivers explanations carrying a statistic-shaped number. */
  numberInMechanism: string[];
  /** basis="data" drivers that name no real dataset column. */
  ungroundedDataDrivers: string[];
  /** Causal connectives found in the measured layer (info-only). */
  unhedgedInMeasured: string[];
  flags: CausalClaimFlag[];
  /** True iff a driver-level (warning/block) flag fired — the verifier should
   *  then request `revise_narrative`. Measured-layer info flags do NOT trip it
   *  (the advisory LLM verifier handles that nuance to avoid revise loops). */
  shouldRevise: boolean;
}

/** Statistic-shaped numbers: percent, decimal, thousands-grouped, or a number
 *  with a quantitative unit / multiplier. Plain small integers, ordinals
 *  ("1st"), and category labels ("Pclass 3") are intentionally NOT matched. */
const STAT_NUMBER_RE =
  /\b\d[\d,]*\.?\d*\s*%|\b\d+\.\d+\b|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:x|×|pp|bps|k|m|bn|million|billion)\b/i;

/** Causal connectives that ASSERT a cause — banned in the measured layer. */
const MEASURED_CAUSAL_RE =
  /\b(?:because(?:\s+of)?|caused by|due to|as a result of|driven by|the reason|attributable to|owing to|stems from|results? from)\b/i;

function hasHedge(text: string): boolean {
  const lower = text.toLowerCase();
  return CAUSAL_HEDGE_TERMS.some((t) => lower.includes(t));
}

function clip(s: string, max = 160): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Does the explanation reference a real dataset column? Conservative: matches
 *  a column name (≥3 chars) as a case-insensitive substring of the prose. */
function referencesColumn(text: string, availableColumns: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return availableColumns.some((c) => {
    const name = c.trim().toLowerCase();
    return name.length >= 3 && lower.includes(name);
  });
}

/**
 * Pure detector. Operates on the structured envelope so it can scope each rule
 * to the right field. `availableColumns` are the dataset's column names (for the
 * data-grounding check).
 */
export function detectUnsupportedCausalClaims(
  output: Pick<
    NarratorOutput,
    "likelyDrivers" | "body" | "findings" | "implications"
  >,
  availableColumns: readonly string[]
): CausalClaimReport {
  const flags: CausalClaimFlag[] = [];
  const unhedgedDrivers: string[] = [];
  const numberInMechanism: string[] = [];
  const ungroundedDataDrivers: string[] = [];
  const unhedgedInMeasured: string[] = [];

  for (const d of output.likelyDrivers ?? []) {
    const explanation = d.explanation ?? "";
    if (!hasHedge(explanation)) {
      unhedgedDrivers.push(explanation);
      flags.push({
        kind: "driver_missing_hedge",
        severity: "warning",
        excerpt: clip(explanation),
        message: `A "why" explanation is stated as fact, not a hypothesis: "${clip(
          explanation,
          120
        )}". Open it with a hedge (likely / consistent with / may reflect).`,
      });
    }
    if (STAT_NUMBER_RE.test(explanation)) {
      numberInMechanism.push(explanation);
      flags.push({
        kind: "driver_number_in_mechanism",
        severity: "warning",
        excerpt: clip(explanation),
        message: `A "why" explanation carries a statistic-shaped number: "${clip(
          explanation,
          120
        )}". Numbers belong in findings/magnitudes — keep the mechanism qualitative.`,
      });
    }
    if (d.basis === "data" && !referencesColumn(explanation, availableColumns)) {
      ungroundedDataDrivers.push(explanation);
      flags.push({
        kind: "driver_data_basis_ungrounded",
        severity: "warning",
        excerpt: clip(explanation),
        message: `A driver claims basis="data" but names no dataset column: "${clip(
          explanation,
          120
        )}". Either cite the real column or re-tag the basis as "domain"/"general".`,
      });
    }
  }

  // Measured layer must stay causation-free. Info-only — surfaced for the LLM
  // verifier (W-CP2); does not, on its own, force a revise (avoids loops on
  // borderline phrasing the LLM can adjudicate).
  const measuredStrings: string[] = [];
  if (output.body) measuredStrings.push(output.body);
  for (const f of output.findings ?? []) {
    if (f.headline) measuredStrings.push(f.headline);
    if (f.evidence) measuredStrings.push(f.evidence);
  }
  for (const i of output.implications ?? []) {
    if (i.statement) measuredStrings.push(i.statement);
    if (i.soWhat) measuredStrings.push(i.soWhat);
  }
  for (const s of measuredStrings) {
    if (MEASURED_CAUSAL_RE.test(s)) {
      unhedgedInMeasured.push(s);
      flags.push({
        kind: "measured_layer_causal_claim",
        severity: "info",
        excerpt: clip(s),
        message: `The measured layer asserts a cause: "${clip(
          s,
          120
        )}". Move the "why" into likelyDrivers (hedged) and keep findings to WHAT the numbers show.`,
      });
    }
  }

  const shouldRevise = flags.some(
    (f) => f.severity === "warning" || f.severity === "block"
  );
  return {
    unhedgedDrivers,
    numberInMechanism,
    ungroundedDataDrivers,
    unhedgedInMeasured,
    flags,
    shouldRevise,
  };
}

/**
 * Belt-and-suspenders sanitizer applied at EMIT time (before persist), so a
 * driver that slipped past both the model and the LLM verifier can never reach
 * the user. Drops unhedged or number-bearing explanations outright, and demotes
 * a falsely "data"-grounded driver to a low-confidence "general" one (keeping the
 * explanation but dropping the unearned grounding). Returns a cleaned array.
 */
export function sanitizeLikelyDrivers(
  drivers: readonly LikelyDriver[] | undefined,
  availableColumns: readonly string[]
): LikelyDriver[] {
  if (!drivers?.length) return [];
  const out: LikelyDriver[] = [];
  for (const d of drivers) {
    const explanation = d.explanation ?? "";
    if (!hasHedge(explanation)) continue; // unhedged assertion → drop
    if (STAT_NUMBER_RE.test(explanation)) continue; // fabricated statistic → drop
    if (d.basis === "data" && !referencesColumn(explanation, availableColumns)) {
      out.push({ ...d, basis: "general", confidence: "low" }); // false grounding → demote
    } else {
      out.push(d);
    }
  }
  return out;
}
