// Period vocabulary — match a header token against known time-period
// patterns. Deterministic, LLM-free, used by the wide-format
// classifier to decide whether a column header encodes a time axis.
//
// Conventions:
// - `matchPeriod(token)` returns null when nothing matches.
// - `iso` is a canonical label suitable for later use as a dimension
//   value. Examples: "2024-03", "2024-Q2", "2024-W12", "MAT-2024-12",
//   "YTD-2024", "L52W".
// - `confidence` reflects ambiguity. Plain "2024" gets 0.55 because
//   it could be a product SKU year; "Jan 2024" gets 0.95.
//
// Scope (W1): Nielsen-primary vocabulary — months, quarters, years,
// weeks, and Nielsen specials MAT / YTD / L[4|12|52]W / P[4|12]W.
// Extensions live in `wide-format.md` "Extension points".

export type PeriodKind =
  | "month"
  | "quarter"
  | "year"
  | "week"
  | "mat"
  | "ytd"
  | "rolling";

export interface PeriodMatch {
  kind: PeriodKind;
  iso: string;
  confidence: number;
  raw: string;
}

const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MONTH_NAMES = Object.keys(MONTH_INDEX).join("|");

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function normalizeYear(y: string): string {
  const n = Number(y);
  if (!Number.isFinite(n)) return y;
  if (n >= 100) return String(n);
  // Two-digit year: 00-79 → 2000-2079, 80-99 → 1980-1999.
  return n < 80 ? String(2000 + n) : String(1900 + n);
}

// ---- Matchers ------------------------------------------------------

// "Jan 2024", "Jan-2024", "Jan '24", "Jan24", "January 2024"
function matchMonthWithYear(tok: string): PeriodMatch | null {
  const re = new RegExp(
    `^(${MONTH_NAMES})[\\s\\-'_]*'?(\\d{2}|\\d{4})$`,
    "i"
  );
  const m = tok.trim().match(re);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  const year = normalizeYear(m[2]);
  return {
    kind: "month",
    iso: `${year}-${pad2(month)}`,
    confidence: 0.95,
    raw: tok,
  };
}

// "2024-01", "2024/03", "2024 Jan"
function matchYearThenMonth(tok: string): PeriodMatch | null {
  const numRe = /^(\d{4})[\s\-\/_](\d{1,2})$/;
  const numM = tok.trim().match(numRe);
  if (numM) {
    const month = Number(numM[2]);
    if (month >= 1 && month <= 12) {
      return {
        kind: "month",
        iso: `${numM[1]}-${pad2(month)}`,
        confidence: 0.9,
        raw: tok,
      };
    }
  }
  const nameRe = new RegExp(`^(\\d{4})[\\s\\-_](${MONTH_NAMES})$`, "i");
  const nameM = tok.trim().match(nameRe);
  if (nameM) {
    const month = MONTH_INDEX[nameM[2].toLowerCase()];
    return {
      kind: "month",
      iso: `${nameM[1]}-${pad2(month)}`,
      confidence: 0.95,
      raw: tok,
    };
  }
  return null;
}

// Bare "Jan", "January" — low confidence without a year.
function matchBareMonth(tok: string): PeriodMatch | null {
  const re = new RegExp(`^(${MONTH_NAMES})$`, "i");
  const m = tok.trim().match(re);
  if (!m) return null;
  const month = MONTH_INDEX[m[1].toLowerCase()];
  return {
    kind: "month",
    iso: `XXXX-${pad2(month)}`,
    confidence: 0.5,
    raw: tok,
  };
}

// "Q1 2024", "Q1-24", "1Q24", "1Q 2024"
function matchQuarter(tok: string): PeriodMatch | null {
  const re1 = /^q([1-4])[\s\-_]*'?(\d{2}|\d{4})$/i;
  const m1 = tok.trim().match(re1);
  if (m1) {
    return {
      kind: "quarter",
      iso: `${normalizeYear(m1[2])}-Q${m1[1]}`,
      confidence: 0.95,
      raw: tok,
    };
  }
  const re2 = /^([1-4])q[\s\-_]*'?(\d{2}|\d{4})$/i;
  const m2 = tok.trim().match(re2);
  if (m2) {
    return {
      kind: "quarter",
      iso: `${normalizeYear(m2[2])}-Q${m2[1]}`,
      confidence: 0.95,
      raw: tok,
    };
  }
  // Bare Q1/Q2/Q3/Q4 — low confidence without year.
  const re3 = /^q([1-4])$/i;
  const m3 = tok.trim().match(re3);
  if (m3) {
    return {
      kind: "quarter",
      iso: `XXXX-Q${m3[1]}`,
      confidence: 0.55,
      raw: tok,
    };
  }
  return null;
}

// "2024", "FY24", "FY2024"
function matchYear(tok: string): PeriodMatch | null {
  const fyRe = /^fy[\s\-_]*'?(\d{2}|\d{4})$/i;
  const fyM = tok.trim().match(fyRe);
  if (fyM) {
    return {
      kind: "year",
      iso: `FY${normalizeYear(fyM[1])}`,
      confidence: 0.85,
      raw: tok,
    };
  }
  const yRe = /^(\d{4})$/;
  const yM = tok.trim().match(yRe);
  if (yM) {
    const year = Number(yM[1]);
    // Be conservative — plain year could be a SKU code; charge low confidence.
    if (year >= 1990 && year <= 2099) {
      return {
        kind: "year",
        iso: yM[1],
        confidence: 0.55,
        raw: tok,
      };
    }
  }
  return null;
}

// "W12", "W12 2024", "Week 12", "WE 2024-03-17", "2024-W12"
function matchWeek(tok: string): PeriodMatch | null {
  const t = tok.trim();
  const isoRe = /^(\d{4})[\s\-]*w(\d{1,2})$/i;
  const isoM = t.match(isoRe);
  if (isoM) {
    return {
      kind: "week",
      iso: `${isoM[1]}-W${pad2(Number(isoM[2]))}`,
      confidence: 0.95,
      raw: tok,
    };
  }
  const wYearRe = /^w(\d{1,2})[\s\-_]*'?(\d{2}|\d{4})$/i;
  const wYearM = t.match(wYearRe);
  if (wYearM) {
    return {
      kind: "week",
      iso: `${normalizeYear(wYearM[2])}-W${pad2(Number(wYearM[1]))}`,
      confidence: 0.9,
      raw: tok,
    };
  }
  const weekWordRe = /^week[\s\-_]*(\d{1,2})(?:[\s\-_]*(\d{2}|\d{4}))?$/i;
  const wwM = t.match(weekWordRe);
  if (wwM) {
    const year = wwM[2] ? normalizeYear(wwM[2]) : "XXXX";
    return {
      kind: "week",
      iso: `${year}-W${pad2(Number(wwM[1]))}`,
      confidence: wwM[2] ? 0.9 : 0.55,
      raw: tok,
    };
  }
  const weRe = /^we[\s\-_]*(\d{4})[\s\-\/](\d{1,2})[\s\-\/](\d{1,2})$/i;
  const weM = t.match(weRe);
  if (weM) {
    return {
      kind: "week",
      iso: `WE-${weM[1]}-${pad2(Number(weM[2]))}-${pad2(Number(weM[3]))}`,
      confidence: 0.95,
      raw: tok,
    };
  }
  const bareW = t.match(/^w(\d{1,2})$/i);
  if (bareW) {
    return {
      kind: "week",
      iso: `XXXX-W${pad2(Number(bareW[1]))}`,
      confidence: 0.5,
      raw: tok,
    };
  }
  return null;
}

// "MAT Dec-24", "MAT Dec 24", "MAT 2024-12", "MAT Dec'24"
function matchMat(tok: string): PeriodMatch | null {
  const t = tok.trim();
  const namedRe = new RegExp(
    `^mat[\\s\\-_]*(${MONTH_NAMES})[\\s\\-_]*'?(\\d{2}|\\d{4})$`,
    "i"
  );
  const named = t.match(namedRe);
  if (named) {
    const month = MONTH_INDEX[named[1].toLowerCase()];
    const year = normalizeYear(named[2]);
    return {
      kind: "mat",
      iso: `MAT-${year}-${pad2(month)}`,
      confidence: 0.97,
      raw: tok,
    };
  }
  const numRe = /^mat[\s\-_]*(\d{4})[\s\-_](\d{1,2})$/i;
  const num = t.match(numRe);
  if (num) {
    return {
      kind: "mat",
      iso: `MAT-${num[1]}-${pad2(Number(num[2]))}`,
      confidence: 0.97,
      raw: tok,
    };
  }
  const barMat = /^mat$/i;
  if (barMat.test(t)) {
    return { kind: "mat", iso: "MAT", confidence: 0.6, raw: tok };
  }
  return null;
}

// "YTD 2024", "YTD Dec 24", "2024 YTD"
function matchYtd(tok: string): PeriodMatch | null {
  const t = tok.trim();
  const prefix = /^ytd[\s\-_]*'?(\d{2}|\d{4})$/i;
  const prefM = t.match(prefix);
  if (prefM) {
    return {
      kind: "ytd",
      iso: `YTD-${normalizeYear(prefM[1])}`,
      confidence: 0.9,
      raw: tok,
    };
  }
  const suffix = /^(\d{4})[\s\-_]*ytd$/i;
  const sufM = t.match(suffix);
  if (sufM) {
    return {
      kind: "ytd",
      iso: `YTD-${sufM[1]}`,
      confidence: 0.9,
      raw: tok,
    };
  }
  const withMonth = new RegExp(
    `^ytd[\\s\\-_]*(${MONTH_NAMES})[\\s\\-_]*'?(\\d{2}|\\d{4})$`,
    "i"
  );
  const wmM = t.match(withMonth);
  if (wmM) {
    const month = MONTH_INDEX[wmM[1].toLowerCase()];
    const year = normalizeYear(wmM[2]);
    return {
      kind: "ytd",
      iso: `YTD-${year}-${pad2(month)}`,
      confidence: 0.92,
      raw: tok,
    };
  }
  if (/^ytd$/i.test(t)) {
    return { kind: "ytd", iso: "YTD", confidence: 0.6, raw: tok };
  }
  return null;
}

// Rolling windows: L4W, L12W, L52W, P4W, P13W, P52W
function matchRolling(tok: string): PeriodMatch | null {
  const re = /^([lp])(\d{1,2})w$/i;
  const m = tok.trim().match(re);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  const n = Number(m[2]);
  // Sanity: only common Nielsen windows.
  if (![4, 12, 13, 26, 52].includes(n)) return null;
  return {
    kind: "rolling",
    iso: `${prefix}${n}W`,
    confidence: 0.9,
    raw: tok,
  };
}

// ---- Public API ---------------------------------------------------

/**
 * Try each matcher in most-specific to least-specific order and
 * return the first hit. Returns null if no pattern matches.
 */
export function matchPeriod(token: string): PeriodMatch | null {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  return (
    matchMat(trimmed) ||
    matchYtd(trimmed) ||
    matchRolling(trimmed) ||
    matchMonthWithYear(trimmed) ||
    matchYearThenMonth(trimmed) ||
    matchQuarter(trimmed) ||
    matchWeek(trimmed) ||
    matchYear(trimmed) ||
    matchBareMonth(trimmed)
  );
}

// Exported for targeted unit testing.
export const __internal__ = {
  matchMonthWithYear,
  matchYearThenMonth,
  matchBareMonth,
  matchQuarter,
  matchYear,
  matchWeek,
  matchMat,
  matchYtd,
  matchRolling,
};
