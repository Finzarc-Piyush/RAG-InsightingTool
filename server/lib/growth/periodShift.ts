// WGR1 · Period-shift utilities for growth analysis (YoY/QoQ/MoM/WoW).
//
// Pure, deterministic functions. Given an ISO period label produced by
// the wide-format `periodVocabulary` matcher (or the standard parser),
// return the prior period at the requested grain.
//
// Supported label shapes:
//   "2024-03"          monthly       — YoY/MoM
//   "2024-Q3"          quarterly     — YoY/QoQ
//   "2024-W12"         weekly        — YoY/WoW
//   "2024"             yearly        — YoY
//   "FY2024"           fiscal year   — YoY (qualifier-stripped)
//   "FY2024-TY/YA/2YA" Nielsen       — YoY (qualifier shift)
//   "L12M"             rolling       — YoY (TY → YA → 2YA → 3YA)
//   "L12M-YA"          rolling       — YoY shift
//   "YTD-TY/YA/2YA"    YTD compare   — YoY shift
//   "MAT-TY/YA/2YA"    MAT compare   — YoY shift
//   "MAT-2024-12"      MAT anchored  — YoY (year shift)
//   "MTD-2024-03"      period-to-date— YoY (year shift)
//   "QTD-2024-Q1"      period-to-date— YoY (year shift)
//
// QoQ/MoM/WoW are only meaningful on the matching grain. Asking
// "QoQ shift of 2024-03" returns null, not a guess. The caller then
// auto-degrades grain (chooseAutoGrain handles the upstream pick).

export type GrowthGrain = "yoy" | "qoq" | "mom" | "wow";

const QUALIFIER_SHIFT: Record<string, string | null> = {
  TY: "YA",
  YA: "2YA",
  "2YA": "3YA",
  // 3YA → null (no further shift available without anchored data)
  "3YA": null,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function shiftQualifier(label: string, leadRegex: RegExp): string | null {
  // Match labels like "L12M", "L12M-YA", "YTD", "YTD-YA", "MAT", "MAT-YA",
  // "FY2024", "FY2024-YA". Shift TY→YA, YA→2YA, 2YA→3YA. Bare lead (no
  // qualifier) becomes lead-YA. Returns null for 3YA (no further depth).
  const m = label.match(leadRegex);
  if (!m) return null;
  const lead = m[1];
  const qualifier = m[2];
  if (!qualifier) return `${lead}-YA`;
  const next = QUALIFIER_SHIFT[qualifier];
  if (!next) return null;
  return `${lead}-${next}`;
}

function shiftYearInLabel(label: string): string | null {
  // Decrement the first 4-digit year token in the label (covers
  // "2024", "FY2024", "2024-03", "2024-Q3", "2024-W12",
  // "MAT-2024-12", "MTD-2024-03", "QTD-2024-Q1", "YTD-2024",
  // "WE-2024-03-17"). Leaves the rest of the label intact.
  const m = label.match(/^(.*?)(\d{4})(.*)$/);
  if (!m) return null;
  const before = m[1];
  const year = Number(m[2]);
  const after = m[3];
  if (!Number.isFinite(year) || year < 1900 || year > 2200) return null;
  return `${before}${year - 1}${after}`;
}

/**
 * Shift the YYYY-MM label backward by N months. Handles year crossings.
 * Returns null on parse failure.
 */
function shiftMonthsBack(label: string, n: number): string | null {
  const m = label.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]);
  month -= n;
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  return `${year}-${pad2(month)}`;
}

/**
 * Shift the YYYY-Q[1-4] label backward by N quarters.
 */
function shiftQuartersBack(label: string, n: number): string | null {
  const m = label.match(/^(\d{4})-Q([1-4])$/);
  if (!m) return null;
  let year = Number(m[1]);
  let quarter = Number(m[2]);
  quarter -= n;
  while (quarter < 1) {
    quarter += 4;
    year -= 1;
  }
  return `${year}-Q${quarter}`;
}

/**
 * Shift the YYYY-Wnn label backward by N weeks. Approximates 52 weeks
 * per year — adequate for YoY pairing on Nielsen weekly panels (which
 * always emit W01–W52 grids); ISO-week-53 years lose one period at the
 * boundary, which the caller surfaces as a NULL prior on growth_pct.
 */
function shiftWeeksBack(label: string, n: number): string | null {
  const m = label.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  let year = Number(m[1]);
  let week = Number(m[2]);
  week -= n;
  while (week < 1) {
    week += 52;
    year -= 1;
  }
  return `${year}-W${pad2(week)}`;
}

/**
 * priorPeriodKey — return the ISO label for the period one `grain` step
 * earlier, or null when the shift is undefined for the input shape.
 */
export function priorPeriodKey(
  iso: string,
  grain: GrowthGrain
): string | null {
  if (!iso || typeof iso !== "string") return null;
  const t = iso.trim();
  if (!t) return null;

  // Nielsen comparative families. YoY shifts the qualifier (TY→YA,
  // YA→2YA, 2YA→3YA). QoQ/MoM/WoW are not meaningful on these
  // aggregated windows.
  if (grain === "yoy") {
    const latestN = shiftQualifier(t, /^(L\d{1,3}[MWYD])(?:-(TY|YA|2YA|3YA))?$/);
    if (latestN !== null) return latestN;
    const ytd = shiftQualifier(t, /^(YTD)(?:-(TY|YA|2YA|3YA))?$/);
    if (ytd !== null) return ytd;
    const mat = shiftQualifier(t, /^(MAT)(?:-(TY|YA|2YA|3YA))?$/);
    if (mat !== null) return mat;
    const mtd = shiftQualifier(t, /^(MTD)(?:-(TY|YA|2YA|3YA))?$/);
    if (mtd !== null) return mtd;
    const qtd = shiftQualifier(t, /^(QTD)(?:-(TY|YA|2YA|3YA))?$/);
    if (qtd !== null) return qtd;
    const wtd = shiftQualifier(t, /^(WTD)(?:-(TY|YA|2YA|3YA))?$/);
    if (wtd !== null) return wtd;
    // FY/CY labels with optional qualifier: "FY2024", "FY2024-YA".
    // YoY → either qualifier-shift OR year-decrement. Prefer
    // year-decrement when no qualifier present (more universally
    // pairable across columns); use qualifier-shift on -YA/-2YA.
    const fyQual = t.match(/^(FY\d{4}|\d{4})-(TY|YA|2YA|3YA)$/);
    if (fyQual) {
      const next = QUALIFIER_SHIFT[fyQual[2]];
      return next ? `${fyQual[1]}-${next}` : null;
    }
    // Half-year labels "2024-H1", "2024-H1-YA".
    const halfQual = t.match(/^(\d{4}-H[12])-(TY|YA|2YA|3YA)$/);
    if (halfQual) {
      const next = QUALIFIER_SHIFT[halfQual[2]];
      return next ? `${halfQual[1]}-${next}` : null;
    }
  }

  if (grain === "yoy") {
    // Anchored MAT/MTD/QTD/YTD with embedded year — shift the year.
    if (/^(?:MAT|MTD|QTD|YTD|WE)-/.test(t)) {
      return shiftYearInLabel(t);
    }
    // Standard YYYY-MM, YYYY-Q[1-4], YYYY-Wnn, YYYY, YYYY-Hn — shift year.
    if (
      /^\d{4}-\d{2}$/.test(t) ||
      /^\d{4}-Q[1-4]$/.test(t) ||
      /^\d{4}-W\d{2}$/.test(t) ||
      /^\d{4}-H[12]$/.test(t) ||
      /^\d{4}-P([1-9]|1[0-3])$/.test(t) ||
      /^\d{4}$/.test(t) ||
      /^FY\d{4}$/.test(t)
    ) {
      return shiftYearInLabel(t);
    }
    return null;
  }

  if (grain === "qoq") {
    return shiftQuartersBack(t, 1);
  }
  if (grain === "mom") {
    return shiftMonthsBack(t, 1);
  }
  if (grain === "wow") {
    return shiftWeeksBack(t, 1);
  }
  return null;
}

// ---------------------------------------------------------------------
// chooseAutoGrain — heuristic grain selection from temporal coverage.
//
// Inputs (as derived by the caller from PeriodIso distinct values, the
// schema's date column, or the wide-format `meltedColumns`):
//   distinctYears        — number of distinct calendar years observed
//   distinctQuartersInOneYear — max distinct quarters within a single year
//   distinctMonthsInOneYear   — max distinct months within a single year
//   weekly               — true iff the period grain is week
//
// Decision rules (ordered):
//   1. ≥2 distinct years AND multi-year coverage → "yoy"
//   2. weekly cadence with ≥4 distinct weeks → "wow" (only meaningful WoW)
//   3. ≥4 distinct quarters in a single year → "qoq"
//   4. ≥3 distinct months in a single year → "mom"
//   5. otherwise → "yoy" (safe default; will fail gracefully on
//      single-period datasets via NULL prior)

export interface TemporalCoverage {
  distinctYears: number;
  distinctQuartersInOneYear?: number;
  distinctMonthsInOneYear?: number;
  weekly?: boolean;
}

export function chooseAutoGrain(coverage: TemporalCoverage): GrowthGrain {
  const years = coverage.distinctYears ?? 0;
  if (years >= 2) return "yoy";
  if (coverage.weekly && years >= 1) return "wow";
  if ((coverage.distinctQuartersInOneYear ?? 0) >= 4) return "qoq";
  if ((coverage.distinctMonthsInOneYear ?? 0) >= 3) return "mom";
  return "yoy";
}

// ---------------------------------------------------------------------
// Convenience — number of periods per year at each grain. Used by the
// SQL builder when emitting `LAG(value, N) OVER (...)` for fixed-shift
// grains over a fully-populated panel. For YoY this is grain-dependent
// (12 monthly, 4 quarterly, 52 weekly, 1 yearly) — caller chooses
// based on the underlying period kind.

export function periodsPerYearForKind(
  kind: "month" | "quarter" | "week" | "year"
): number {
  if (kind === "month") return 12;
  if (kind === "quarter") return 4;
  if (kind === "week") return 52;
  return 1;
}
