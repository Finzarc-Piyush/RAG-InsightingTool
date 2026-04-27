/**
 * W3 · clean fallback renderer used when the synthesizer's narrative LLM
 * paths all return empty/refused. The legacy fallback was
 *
 *   "Summary from tool output:\n\n[execute_query_plan] Grouped by Region…
 *    Sample: [{...}]"
 *
 * — i.e. internal observation prefixes leaked to the user. This module
 * replaces that with either a markdown table parsed from the latest tool
 * Sample block, or a clean apology line. The literal strings
 * `"Summary from tool output:"` and `"[execute_query_plan]"` MUST never
 * appear in the output.
 */

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
    if (!Number.isInteger(v)) {
      return v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
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
