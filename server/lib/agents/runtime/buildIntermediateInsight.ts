import type { ToolResult } from "./toolRegistry.js";

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 3))}...`;
}

/**
 * Build a short, deterministic client-visible insight for intermediate previews.
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

  // Prefer the first sentence for readability.
  const m = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  const first = m?.[1] ?? normalized;

  return truncate(first, 240);
}

