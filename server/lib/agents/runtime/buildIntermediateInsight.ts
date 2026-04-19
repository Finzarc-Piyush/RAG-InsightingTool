import type { ToolResult } from "./toolRegistry.js";

/**
 * Build a deterministic client-visible insight for intermediate previews.
 *
 * We keep this intentionally lightweight (no extra LLM calls).
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

