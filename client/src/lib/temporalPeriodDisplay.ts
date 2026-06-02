/**
 * Human label for a CANONICAL period key — the client mirror of the server's
 * `formatPeriodKeyForDisplay` (server/lib/dateUtils.ts). Charts and filters now
 * carry canonical, sortable keys ("2023-Q1") as their values; this turns them
 * into display labels at the render layer only, so chronological order (driven by
 * the canonical key via `compareTemporalOrLexicalLabels`) is never disturbed and
 * quarters are never re-cast as months.
 *
 *   "2023"        → "2023"
 *   "2023-Q1"     → "Q1 2023"
 *   "2023-H1"     → "H1 2023"
 *   "2023-01"     → "Jan 2023"
 *   "2023-W12"    → "W12 2023"
 *   "2023-01-15"  → "15 Jan 2023"
 * Relative / unknown keys (e.g. "L12M", "YTD-TY", a plain category) pass through.
 */
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function formatTemporalPeriodKeyForDisplay(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  if (!s) return "";
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-Q([1-4])$/))) return `Q${m[2]} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-H([12])$/))) return `H${m[2]} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-W(\d{1,2})$/))) return `W${Number(m[2])} ${m[1]}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${Number(m[3])} ${MONTH_SHORT[mi]} ${m[1]}`;
  }
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${MONTH_SHORT[mi]} ${m[1]}`;
  }
  return s;
}

/** True when a value is a canonical period key this module knows how to format. */
export function isCanonicalPeriodKey(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}(-(Q[1-4]|H[12]|W\d{1,2}|\d{2}|\d{2}-\d{2}))?$/.test(value.trim())
  );
}
