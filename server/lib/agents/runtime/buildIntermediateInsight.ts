/**
 * ============================================================================
 * buildIntermediateInsight.ts — quick preview line from a finished tool step
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Turns a tool's result summary into a short, human-readable line the client
 *   can show mid-turn (a "preview" of progress, before the full answer lands).
 *   It prefers the first sentence of the summary, but keeps the full text if
 *   there is no clear sentence break.
 *
 * WHY IT MATTERS
 *   Lets the UI show running "key insight" snippets as each tool finishes,
 *   without spending an extra LLM call — it is purely deterministic string work
 *   ("deterministic" = same input always gives the same output, no AI involved).
 *
 * KEY PIECES
 *   - buildIntermediateInsight(toolName, stepResult) — returns the preview
 *     string, or undefined when the step has no summary.
 *
 * HOW IT CONNECTS
 *   Reads ToolResult from toolRegistry.ts. Called by the act loop while
 *   streaming intermediate progress to the client.
 */
import type { ToolResult } from "./toolRegistry.js";

/**
 * Build a deterministic client-visible insight for intermediate previews.
 * Intentionally lightweight — no extra LLM calls.
 */
export function buildIntermediateInsight(
  _toolName: string,
  stepResult: ToolResult
): string | undefined {
  const raw = stepResult.summary?.trim();
  if (!raw) return undefined;

  const normalized = raw.replace(/\s+/g, " ").trim();

  // Prefer the first sentence for readability; keep full text (no truncation)
  // so Key insight matches tool output and stays consistent with Thinking.
  const m = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return m?.[1] ?? normalized;
}

