/**
 * ============================================================================
 * synthesisFallback.ts — produce a clean answer when the narrator LLM gives us
 * nothing usable
 * ============================================================================
 * WHAT THIS FILE DOES
 *   At the end of a turn the "synthesizer" (narrator) LLM is supposed to write
 *   the final answer. Sometimes it returns empty text or refuses. This module
 *   is the safety net for that case: it scans the tools' raw output strings
 *   ("observations") for the most recent `Sample: [...]` block (a small JSON
 *   sample of result rows the tools emit), parses it, and renders it as a clean
 *   GitHub-flavored markdown table. If no parseable sample exists, it returns a
 *   short, polite apology line instead.
 *
 * WHY IT MATTERS
 *   The user must never see leaked internal plumbing. An older fallback dumped
 *   raw observation text like `Summary from tool output: [execute_query_plan]…`.
 *   This module guarantees the output is either a tidy table or a clean apology
 *   — the literal strings `"Summary from tool output:"` and
 *   `"[execute_query_plan]"` MUST never appear in what it returns.
 *
 * KEY PIECES
 *   - renderFallbackAnswer — main entry: observations[] in, { content, tableMarkdown } out
 *   - extractTableFromObservations / extractFirstJsonArray — find + balance-parse the Sample[] block
 *   - renderRowsAsMarkdownTable / formatCell — turn parsed rows into a readable table
 *
 * HOW IT CONNECTS
 *   Pure (no I/O, no LLM, no clock) so it is safe to call from anywhere in the
 *   synthesis path. Uses `formatCompactNumber` from `../../formatCompactNumber.js`
 *   to keep large numbers manager-friendly (710K, 1.95M).
 */

import { formatCompactNumber } from "../../formatCompactNumber.js";

export interface FallbackRender {
  content: string;
  /** Present only when a Sample[] block was successfully parsed into a table. */
  tableMarkdown: string | null;
}

const FAILED_MESSAGE_NO_TABLE =
  "Synthesis failed; please retry the question or rephrase.";

const FAILED_MESSAGE_WITH_TABLE =
  "I retrieved the data but couldn't generate a written summary. Here's the result:";

/**
 * Render a clean fallback answer from the synthesizer's observations array.
 * Pure: no I/O, no LLM, no clock dependence — safe to call from anywhere.
 *
 * Strategy:
 *  1. Walk observations from newest→oldest looking for a `Sample: [...]`
 *     block (emitted by tool runners for analytical tools).
 *  2. Try `JSON.parse` on that block. Accept only an array of objects.
 *  3. Render columns (= union of object keys, in first-row order) as a
 *     GitHub-flavored markdown table; format numeric values with
 *     two-decimal precision and comma thousands grouping; cap at 50 rows.
 *  4. If no parseable Sample block exists, return the no-table apology
 *     line. Never echo raw observation prefixes.
 */
export function renderFallbackAnswer(observations: string[]): FallbackRender {
  const tableMarkdown = extractTableFromObservations(observations);
  if (tableMarkdown) {
    return {
      content: `${FAILED_MESSAGE_WITH_TABLE}\n\n${tableMarkdown}`,
      tableMarkdown,
    };
  }
  return { content: FAILED_MESSAGE_NO_TABLE, tableMarkdown: null };
}

function extractTableFromObservations(observations: string[]): string | null {
  for (let i = observations.length - 1; i >= 0; i--) {
    const obs = observations[i];
    if (typeof obs !== "string") continue;
    const sampleStart = obs.indexOf("Sample:");
    if (sampleStart < 0) continue;
    const arrayBlock = extractFirstJsonArray(obs.slice(sampleStart));
    if (!arrayBlock) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(arrayBlock);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const rows = parsed.filter(
      (r): r is Record<string, unknown> =>
        r !== null && typeof r === "object" && !Array.isArray(r)
    );
    if (rows.length === 0) continue;
    const md = renderRowsAsMarkdownTable(rows);
    if (md) return md;
  }
  return null;
}

/**
 * Pull the first balanced `[...]` JSON array out of a string that begins
 * with (or contains) one. Tolerates surrounding prose, balances brackets
 * inside quoted strings, and returns `null` if no balanced array is found.
 */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function renderRowsAsMarkdownTable(rows: Record<string, unknown>[]): string | null {
  const MAX_ROWS = 50;
  const limited = rows.slice(0, MAX_ROWS);
  const columns = collectColumnsInFirstRowOrder(limited);
  if (columns.length === 0) return null;

  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = limited
    .map((row) => `| ${columns.map((c) => formatCell(row[c])).join(" | ")} |`)
    .join("\n");
  return [header, separator, body].join("\n");
}

function collectColumnsInFirstRowOrder(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    // Readers are managers / CXOs — render large numbers compactly
    // (710K, 1.95M) instead of raw decimals (710,212.40). Keep small numbers
    // (< 1000) precise so percentages, ratios, and counts stay readable.
    if (Math.abs(v) >= 1000) {
      return formatCompactNumber(v);
    }
    if (!Number.isInteger(v)) {
      return v.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    }
    return v.toLocaleString("en-US");
  }
  if (typeof v === "string") {
    // Escape pipes so they do not break the table layout.
    return v.replace(/\|/g, "\\|");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  try {
    return JSON.stringify(v).replace(/\|/g, "\\|");
  } catch {
    return String(v);
  }
}
