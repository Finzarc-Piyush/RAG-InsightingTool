/**
 * ============================================================================
 * automationRemap.ts — match a saved analysis's columns onto a freshly
 * uploaded dataset so the automation can replay
 * ============================================================================
 * WHAT THIS FILE DOES
 *   An "automation" is a saved analysis recipe the user can re-run on new data
 *   (e.g. next month's sales file). For the replay to work, the columns the
 *   recipe expects must be matched to the new file's columns. This file does
 *   that matching: first it pairs columns whose names are identical
 *   (case-insensitive), then for any saved column that has no exact match it
 *   asks a small/cheap LLM to propose the most likely new-dataset column —
 *   based on name similarity, type compatibility, and overlapping sample values
 *   — returning each guess with a high/medium/low confidence and a short reason.
 *
 * WHY IT MATTERS
 *   Real-world files drift: "Q1 23 Value Sales" becomes "Q1 24 Value Sales",
 *   casing changes, abbreviations appear. Without this remap an automation would
 *   silently break or run against the wrong column. It is defensive: any LLM
 *   guess that names a column that doesn't actually exist is downgraded to
 *   "unmatchable", and on LLM failure every unmatched column is reported so the
 *   user can fix or cancel — never a silent partial mapping.
 *
 * KEY PIECES
 *   - computeAutomationColumnRemap — main: exact-match diff + LLM call for the remainder
 *   - AutomationDryRunResult shape: { exactMatches, proposedMappings, unmatchable }
 *
 * HOW IT CONNECTS
 *   Pure orchestrator — does NOT mutate the saved recipe. Consumes
 *   `AutomationColumnInfo` and returns `AutomationDryRunResult` (both from
 *   `../../../shared/schema.js`). Calls the LLM via `completeJson` (llmJson.js).
 *   The automation run/dry-run endpoints surface the result for the user to
 *   confirm or edit before the actual replay starts.
 */

import { z } from "zod";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import type {
  AutomationColumnInfo,
  AutomationDryRunResult,
} from "../../../shared/schema.js";

type OnLlmCall = () => void;

const llmRemapItemSchema = z.object({
  saved: z.string(),
  suggested: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string().max(400).optional(),
});

const llmRemapOutputSchema = z.object({
  proposedMappings: z.array(llmRemapItemSchema).max(60),
});

const SYSTEM_PROMPT = `You are matching column names from a SAVED ANALYSIS to a NEW DATASET so an automation can replay deterministically against the new data.

For EACH unmatched saved column, propose ONE new-dataset column that most likely represents the same field. Base the match on:
  1. Name similarity (case-insensitive, allowing token reorders, abbreviations like "Sale Value" ↔ "Sales", suffix changes like "Q1 23 Value Sales" ↔ "Q1 24 Value Sales").
  2. Type compatibility (number ↔ number, string ↔ string, date ↔ date).
  3. Sample-value overlap (high overlap → strong match).

Confidence rubric:
  • "high"   = name is essentially the same modulo casing/whitespace; type matches; sample-value distributions overlap.
  • "medium" = name is plausibly the same field after light token reasoning (synonym, abbreviation); type matches.
  • "low"    = best-guess, but the user should confirm — name has weak signal OR types diverge OR samples don't overlap.

If NO new-dataset column is a plausible match, return suggested = null with confidence = "low" and a one-line reason. The user will see this and can either map manually or cancel the run.

Output JSON ONLY: { "proposedMappings": [ { "saved": "...", "suggested": "..." | null, "confidence": "...", "reason": "..." } ] }

Be terse in reasons (≤ 200 chars). Never invent column names — every "suggested" must be a verbatim string from the new-dataset column list.`;

const summariseColumn = (c: AutomationColumnInfo, maxSamples: number = 4): string => {
  const samples = (c.sampleValues ?? [])
    .slice(0, maxSamples)
    .map((v: unknown) =>
      typeof v === "string" ? `"${v.slice(0, 40)}"` : String(v)
    )
    .join(", ");
  return `  - "${c.name}" (type: ${c.type}${samples ? `, samples: [${samples}]` : ""})`;
};

const buildUserPrompt = (
  unmatched: AutomationColumnInfo[],
  newColumns: AutomationColumnInfo[]
): string => {
  return [
    "UNMATCHED SAVED COLUMNS (need a new-dataset match for each):",
    unmatched.map((c) => summariseColumn(c)).join("\n"),
    "",
    "NEW DATASET COLUMNS (choose from these — verbatim names only):",
    newColumns.map((c) => summariseColumn(c, 3)).join("\n"),
    "",
    `Return one entry per unmatched column above (${unmatched.length} entries total). Use the rubric in the system prompt.`,
  ].join("\n");
};

export interface ComputeRemapOptions {
  turnId?: string;
  onLlmCall?: OnLlmCall;
}

/**
 * Compute the dry-run mapping result. Strict by-name matches are
 * extracted deterministically; the LLM is only invoked for the
 * unmatched remainder. When every saved column matches by name, the
 * function returns immediately with no LLM call.
 */
export async function computeAutomationColumnRemap(
  savedColumns: AutomationColumnInfo[],
  newColumns: AutomationColumnInfo[],
  opts: ComputeRemapOptions = {}
): Promise<AutomationDryRunResult> {
  const newNamesLower = new Map<string, string>();
  for (const c of newColumns) {
    newNamesLower.set(c.name.toLowerCase(), c.name);
  }

  const exactMatches: string[] = [];
  const unmatched: AutomationColumnInfo[] = [];
  for (const saved of savedColumns) {
    const matchedNewName = newNamesLower.get(saved.name.toLowerCase());
    if (matchedNewName !== undefined) {
      // Case-insensitive exact match — treat as identity (caller may
      // need to substitute case-corrected name; the column-mapping
      // composer skips identity mappings, so case differences will
      // propagate when caller adds them explicitly).
      exactMatches.push(matchedNewName);
    } else {
      unmatched.push(saved);
    }
  }

  if (unmatched.length === 0) {
    return {
      exactMatches,
      proposedMappings: [],
      unmatchable: [],
    };
  }

  const result = await completeJson(
    SYSTEM_PROMPT,
    buildUserPrompt(unmatched, newColumns),
    llmRemapOutputSchema,
    {
      turnId: `${opts.turnId ?? "automation_remap"}_remap`,
      maxTokens: 2000,
      temperature: 0.2,
      onLlmCall: opts.onLlmCall,
      purpose: LLM_PURPOSE.AUTOMATION_REMAP,
    }
  );

  if (!result.ok) {
    // LLM failure: every unmatched column becomes "unmatchable" so the
    // user sees the problem and can cancel cleanly. Better than a
    // silent partial mapping.
    return {
      exactMatches,
      proposedMappings: [],
      unmatchable: unmatched.map((c) => c.name),
    };
  }

  // Defence: drop any LLM proposal whose `suggested` is not a verbatim
  // new-column name (the system prompt forbids inventions, but we don't
  // trust the LLM blindly — surface invented names as null/unmatchable).
  const newNamesExact = new Set(newColumns.map((c) => c.name));
  const proposedMappings: AutomationDryRunResult["proposedMappings"] = [];
  for (const item of result.data.proposedMappings) {
    if (item.suggested === null || item.suggested === "") {
      proposedMappings.push({
        saved: item.saved,
        suggested: null,
        confidence: item.confidence,
        reason: item.reason,
      });
      continue;
    }
    if (!newNamesExact.has(item.suggested)) {
      proposedMappings.push({
        saved: item.saved,
        suggested: null,
        confidence: "low",
        reason: `LLM suggested "${item.suggested}" but no such column exists in the new dataset.`,
      });
      continue;
    }
    proposedMappings.push(item);
  }

  // Saved columns the LLM did not address at all → unmatchable. Avoids
  // silently dropping columns the user expected to be remapped.
  const addressedSaved = new Set(
    proposedMappings.map((p: { saved: string }) => p.saved)
  );
  const unmatchable: string[] = [];
  for (const c of unmatched) {
    if (!addressedSaved.has(c.name)) unmatchable.push(c.name);
  }
  // Also: every proposal with null suggested is added to unmatchable so
  // the client renders the red "missing matches" banner uniformly.
  for (const p of proposedMappings) {
    if (p.suggested === null && !unmatchable.includes(p.saved)) {
      unmatchable.push(p.saved);
    }
  }

  return {
    exactMatches,
    proposedMappings,
    unmatchable,
  };
}
