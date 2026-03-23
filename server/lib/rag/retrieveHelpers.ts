import type { DataSummary } from "../../shared/schema.js";
import type { RagHit } from "./ragHit.js";

/**
 * Extract schema column names that appear in retrieved chunk text (for planner chaining).
 */
export function suggestedColumnsFromHits(hits: RagHit[], summary: DataSummary): string[] {
  const found = new Set<string>();
  const blob = hits.map((h) => h.content).join("\n").toLowerCase();
  for (const col of summary.columns) {
    const name = col.name;
    if (!name) continue;
    if (blob.includes(name.toLowerCase())) {
      found.add(name);
    }
  }
  return Array.from(found).slice(0, 12);
}

export function formatHitsForPrompt(hits: RagHit[], maxChars = 8000): string {
  if (hits.length === 0) {
    return "";
  }
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const block = `[${h.chunkType}:${h.chunkId}]\n${h.content}\n`;
    if (used + block.length > maxChars) {
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n---\n");
}
