import type { DataSummary } from "../shared/schema.js";
// Diagnostic-mode vocabulary is owned by the query-intent authority (single
// source of truth for question-intent regexes) — this module used to carry its
// own DIAGNOSTIC_RE, which drifted against the routing/depth classifiers.
import { DIAGNOSTIC_MODE_RE } from "./agents/runtime/queryIntentAuthority.js";

export type AnalysisMode = "descriptive" | "diagnostic";

export interface AnalysisSpec {
  mode: AnalysisMode;
  /** Primary numeric outcome when inferrable (e.g. Sales). */
  outcomeColumn?: string;
}

/**
 * Lightweight heuristic router (no extra LLM). Used for gating UX merges and planner hints.
 */
export function classifyAnalysisSpec(
  question: string,
  summary: DataSummary
): AnalysisSpec {
  const q = question.trim();
  if (!q) return { mode: "descriptive" };

  const mode: AnalysisMode = DIAGNOSTIC_MODE_RE.test(q) ? "diagnostic" : "descriptive";

  let outcomeColumn: string | undefined;
  const numerics = summary.numericColumns || [];
  const lower = q.toLowerCase();
  const preferOrder = ["Sales", "Profit", "Revenue", "Quantity", "Discount"];
  for (const label of preferOrder) {
    const hit = numerics.find((c) => c.toLowerCase() === label.toLowerCase());
    if (hit && new RegExp(`\\b${label}\\b`, "i").test(q)) {
      outcomeColumn = hit;
      break;
    }
  }
  if (!outcomeColumn && numerics.length) {
    if (/\b(sales|revenue)\b/i.test(lower)) {
      outcomeColumn =
        numerics.find((c) => /sales|revenue/i.test(c)) ?? numerics[0];
    } else if (/\bprofit\b/i.test(lower)) {
      outcomeColumn = numerics.find((c) => /profit/i.test(c)) ?? numerics[0];
    } else if (/\bquantity|units?\b/i.test(lower)) {
      outcomeColumn = numerics.find((c) => /quant|qty|units?/i.test(c)) ?? numerics[0];
    } else {
      outcomeColumn = numerics[0];
    }
  }

  return { mode, outcomeColumn };
}
