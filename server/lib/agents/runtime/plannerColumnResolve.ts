/**
 * ============================================================================
 * plannerColumnResolve.ts — snaps a loose column name to a real schema column
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the planning LLM writes a column name, it often doesn't match the
 *   dataset's actual column exactly — wrong case, extra spaces, an underscore vs
 *   a space, or a partial name ("Revenue" for "Total Revenue"). These pure
 *   functions try to map that loose string to the ONE correct column from the
 *   data summary, but ONLY when the match is unambiguous. If they can't be sure,
 *   they return the original string unchanged so the downstream Zod + column-
 *   allowlist validation rejects it loudly instead of silently guessing wrong.
 *
 * WHY IT MATTERS
 *   Binding a query to the wrong column silently produces a confidently wrong
 *   answer — the worst failure mode for an analytics tool. This is the safe,
 *   conservative resolver that runs before validation: it fixes obvious
 *   formatting mismatches without ever inventing an unsafe match.
 *
 * KEY PIECES
 *   - resolveToSchemaColumn — the main resolver. Tries exact → case-insensitive →
 *     whitespace-compacted → normalised → substring/token-overlap matches, each
 *     only when it yields a single unambiguous hit.
 *   - resolveMetricAliasToSchemaColumn — extra pass for metric-like aliases
 *     ("Total_Revenue") that maps to a numeric/metric column when unambiguous.
 *   - GENERIC_SUBSTRING_DENY (internal) — short generic tokens ("date", "id",
 *     "name"...) that are NOT allowed to substring-match, so "Date" can't hijack
 *     "Order Date".
 *
 * HOW IT CONNECTS
 *   Reads WideFormatTransform (shared/schema.js). Called by the planner before
 *   building/validating a query plan.
 *
 * EDGE CASE — wide-format ("melted") columns:
 *   At upload time a "wide" dataset (e.g. one column per quarter) is reshaped
 *   ("melted") into long form, so those original headers no longer exist as
 *   columns. If the LLM asks for one of those stale headers, fuzzy matching is
 *   refused — otherwise "Q1 23 Value Sales" would silently bind to the substring
 *   "Value". The raw value is returned so validation surfaces a clear error.
 */
import type { WideFormatTransform } from "../../../shared/schema.js";

/**
 * Returns true when the requested column name was a wide-format header that was
 * melted away at upload time. Caller should refuse the fuzzy match (would
 * otherwise silently bind to a substring like Period or Value) and surface a
 * corrective error.
 */
function isStaleWideFormatColumn(
  name: string,
  wideFormatTransform?: WideFormatTransform
): boolean {
  if (!wideFormatTransform?.detected) return false;
  const lower = name.trim().toLowerCase();
  return wideFormatTransform.meltedColumns.some(
    (c) => c.trim().toLowerCase() === lower
  );
}
function tokenOverlapScore(a: string, b: string): number {
  const aw = a
    .toLowerCase()
    .split(/[\s_\-/()]+/)
    .filter((w) => w.length > 1);
  const bw = b
    .toLowerCase()
    .split(/[\s_\-/()]+/)
    .filter((w) => w.length > 1);
  if (!aw.length || !bw.length) return 0;
  const setB = new Set(bw);
  let n = 0;
  for (const w of aw) {
    if (setB.has(w)) n += 2;
    else {
      for (const x of bw) {
        if (w.includes(x) || x.includes(w)) {
          n += 1;
          break;
        }
      }
    }
  }
  return n;
}

/** Standalone generic tokens — do not substring-resolve to avoid hijacking (e.g. "Date" → "Order Date"). */
const GENERIC_SUBSTRING_DENY = new Set([
  "date",
  "name",
  "id",
  "qty",
  "num",
  "type",
  "code",
  "key",
  "cat",
]);

/**
 * Bidirectional substring match: one string contains the other (after trim).
 * Prefer a single unambiguous hit; if several, pick by best token overlap with raw.
 */
function resolveBySubstringOrTokens(
  t: string,
  tl: string,
  columns: readonly { name: string }[]
): string | null {
  if (GENERIC_SUBSTRING_DENY.has(tl) && t.length <= 6) {
    return null;
  }
  const subs = columns.filter((c) => {
    const cl = c.name.toLowerCase();
    if (cl.length < 2 || tl.length < 2) return cl === tl;
    return cl.includes(tl) || tl.includes(cl);
  });
  if (subs.length === 1) return subs[0].name;
  if (subs.length < 2) return null;
  let best: { name: string; score: number } | null = null;
  for (const c of subs) {
    const score = tokenOverlapScore(t, c.name);
    if (
      !best ||
      score > best.score ||
      (score === best.score && c.name.length < best.name.length)
    ) {
      best = { name: c.name, score };
    }
  }
  if (!best || best.score < 1) return null;
  const tied = subs.filter(
    (c) => tokenOverlapScore(t, c.name) === best!.score
  );
  return tied.length === 1 ? best.name : null;
}

export function resolveToSchemaColumn(
  raw: string,
  columns: readonly { name: string }[],
  wideFormatTransform?: WideFormatTransform
): string {
  const t = raw.trim();
  if (!t) return raw;
  if (columns.some((c) => c.name === t)) return t;
  // Refuse to fuzzy-match a stale wide-format column name. Returning the raw
  // value keeps the existing "if it doesn't match a real column,
  // pass through unchanged" contract — downstream Zod / column-allowlist
  // validation will then reject it loudly with a clear error, instead of
  // silently binding "Q1 23 Value Sales" to the substring "Value".
  if (isStaleWideFormatColumn(t, wideFormatTransform)) return raw;
  const tl = t.toLowerCase();
  const caseInsensitive = columns.filter((c) => c.name.toLowerCase() === tl);
  if (caseInsensitive.length === 1) return caseInsensitive[0].name;
  const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const compactHits = columns.filter((c) => compact(c.name) === compact(t));
  if (compactHits.length === 1) return compactHits[0].name;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normHits = columns.filter((c) => norm(c.name) === norm(t));
  if (normHits.length === 1) return normHits[0].name;
  const sub = resolveBySubstringOrTokens(t, tl, columns);
  if (sub) return sub;
  return raw;
}

/**
 * Money/value measure-name vocabulary used to recognise a metric column by name.
 * One named constant — this regex was previously inlined twice in the function
 * below (the gate test + the candidate filter), which is exactly the kind of
 * copy that drifts. NOTE: deliberately distinct from the client's currency-
 * FORMATTING `CURRENCY_RE` and the FMCG rate/outcome detectors — those are
 * tuned per concern (formatting vs resolution vs aggregation) and are NOT unified
 * here to avoid changing number formatting without visual QA.
 */
const MONEY_MEASURE_NAME_RE =
  /revenue|sales|amount|value|total|gmv|turnover|income/;

/**
 * Resolve metric-like aliases (e.g. "Total_Revenue") to a schema metric column
 * when the mapping is unambiguous.
 */
export function resolveMetricAliasToSchemaColumn(
  raw: string,
  columns: readonly { name: string }[],
  preferredNumeric: readonly string[] = []
): string {
  const direct = resolveToSchemaColumn(raw, columns);
  if (columns.some((c) => c.name === direct)) return direct;

  const t = raw.trim();
  if (!t) return raw;
  const tl = t.toLowerCase();
  if (!MONEY_MEASURE_NAME_RE.test(tl)) return raw;

  const preferred = new Set(preferredNumeric.filter(Boolean));
  const candidates = columns.filter((c) => {
    const cl = c.name.toLowerCase();
    return MONEY_MEASURE_NAME_RE.test(cl) || preferred.has(c.name);
  });
  if (candidates.length === 1) return candidates[0].name;
  if (preferred.size === 1) return Array.from(preferred)[0];
  return raw;
}
