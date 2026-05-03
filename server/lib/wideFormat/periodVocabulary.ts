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
  | "rolling"
  | "latest_n";

// Trailing decoration on Nielsen columns: week-ending, month-ending,
// or period-ending date appended after the canonical period token,
// e.g. "Q1 23 - w/e 23/03/23", "MAT Dec-24 - m/e 31/12/24",
// "P1 24 - p/e 28/01/24". The leading token wins; matchPeriod strips
// this when direct matching fails.
const WE_DECORATION =
  /[\s\-_:]*(?:w\/?e|week\s*ending|m\/?e|month\s*ending|p\/?e|period\s*ending)\s+\d{1,2}[\s\-\/]\d{1,2}[\s\-\/]\d{2,4}\s*$/i;

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

// "2024", "FY24", "FY2024", "FY24 YA", "FY24 2YA",
// "Calendar Year 2024", "CY 2024" (Marico India fiscal vs. calendar
// distinction).
function matchYear(tok: string): PeriodMatch | null {
  const t = tok.trim();
  const fyRe = /^fy[\s\-_]*'?(\d{2}|\d{4})(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const fyM = t.match(fyRe);
  if (fyM) {
    const qual = fyM[2] ? `-${fyM[2].toUpperCase()}` : "";
    return {
      kind: "year",
      iso: `FY${normalizeYear(fyM[1])}${qual}`,
      confidence: 0.85,
      raw: tok,
    };
  }
  const cyRe = /^(?:cy|calendar[\s\-_]+year)[\s\-_]*'?(\d{2}|\d{4})(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const cyM = t.match(cyRe);
  if (cyM) {
    const qual = cyM[2] ? `-${cyM[2].toUpperCase()}` : "";
    return {
      kind: "year",
      iso: `${normalizeYear(cyM[1])}${qual}`,
      confidence: 0.85,
      raw: tok,
    };
  }
  const yRe = /^(\d{4})$/;
  const yM = t.match(yRe);
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

// "H1 24", "H2 2024", "H1 23 YA", "H1 23 2YA" — half-year columns
// common in fiscal-year reporting (Marico India H1/H2 splits).
function matchHalfYear(tok: string): PeriodMatch | null {
  const re = /^h([12])[\s\-_]+'?(\d{2}|\d{4})(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const m = tok.trim().match(re);
  if (!m) return null;
  const half = m[1];
  const year = normalizeYear(m[2]);
  const qual = m[3] ? `-${m[3].toUpperCase()}` : "";
  return {
    kind: "quarter", // reuse 'quarter' kind to keep agent temporal capabilities simple
    iso: `${year}-H${half}${qual}`,
    confidence: 0.92,
    raw: tok,
  };
}

// "MTD", "MTD May 24", "MTD YA", "QTD", "QTD Q1 24", "WTD",
// "WTD YA" — period-to-date columns. Treated as ytd-kind so
// downstream consumers handle them with the same logic.
function matchPeriodToDate(tok: string): PeriodMatch | null {
  const t = tok.trim();
  // Bare MTD/QTD/WTD.
  if (/^(mtd|qtd|wtd)$/i.test(t)) {
    return {
      kind: "ytd",
      iso: t.toUpperCase(),
      confidence: 0.62,
      raw: tok,
    };
  }
  // {MTD|QTD|WTD} {TY|YA|2YA|3YA}.
  const compRe = /^(mtd|qtd|wtd)[\s\-_]+(ty|ya|2ya|3ya)$/i;
  const compM = t.match(compRe);
  if (compM) {
    return {
      kind: "ytd",
      iso: `${compM[1].toUpperCase()}-${compM[2].toUpperCase()}`,
      confidence: 0.9,
      raw: tok,
    };
  }
  // MTD with month + year ("MTD May 24", "MTD Jun-2024").
  const mtdMonthRe = new RegExp(
    `^mtd[\\s\\-_]+(${MONTH_NAMES})[\\s\\-_]*'?(\\d{2}|\\d{4})$`,
    "i"
  );
  const mtdM = t.match(mtdMonthRe);
  if (mtdM) {
    const month = MONTH_INDEX[mtdM[1].toLowerCase()];
    const year = normalizeYear(mtdM[2]);
    return {
      kind: "ytd",
      iso: `MTD-${year}-${pad2(month)}`,
      confidence: 0.92,
      raw: tok,
    };
  }
  // QTD with quarter + year ("QTD Q1 24").
  const qtdRe = /^qtd[\s\-_]+q([1-4])[\s\-_]*'?(\d{2}|\d{4})$/i;
  const qtdM = t.match(qtdRe);
  if (qtdM) {
    return {
      kind: "ytd",
      iso: `QTD-${normalizeYear(qtdM[2])}-Q${qtdM[1]}`,
      confidence: 0.92,
      raw: tok,
    };
  }
  return null;
}

// Nielsen 4-week sales periods: "P1 24", "P13 23", "P1 2024".
// 13 four-week periods per year — an alternative calendar in some
// Nielsen panels. Distinct from the rolling "P4W" / "P13W" matcher
// (those have a trailing 'W' and no year).
function matchPeriodCode(tok: string): PeriodMatch | null {
  const re = /^p([1-9]|1[0-3])[\s\-_]+'?(\d{2}|\d{4})(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const m = tok.trim().match(re);
  if (!m) return null;
  const period = Number(m[1]);
  if (period < 1 || period > 13) return null;
  const year = normalizeYear(m[2]);
  const qual = m[3] ? `-${m[3].toUpperCase()}` : "";
  return {
    kind: "rolling",
    iso: `${year}-P${period}${qual}`,
    confidence: 0.85,
    raw: tok,
  };
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
  // Nielsen "w/e DD/MM/YY" / "we DD/MM/YYYY" — week-ending date in DMY order.
  const weDmyRe = /^w\/?e[\s\-_:]+(\d{1,2})[\s\-\/](\d{1,2})[\s\-\/](\d{2}|\d{4})$/i;
  const weDmyM = t.match(weDmyRe);
  if (weDmyM) {
    const day = Number(weDmyM[1]);
    const month = Number(weDmyM[2]);
    const year = normalizeYear(weDmyM[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return {
        kind: "week",
        iso: `WE-${year}-${pad2(month)}-${pad2(day)}`,
        confidence: 0.95,
        raw: tok,
      };
    }
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

// "MAT Dec-24", "MAT Dec 24", "MAT 2024-12", "MAT Dec'24",
// plus comparatives: "MAT TY", "MAT YA", "MAT 2YA",
// "MAT Dec-24 YA", "MAT Dec 24 2YA".
function matchMat(tok: string): PeriodMatch | null {
  const t = tok.trim();
  // Named month + year + optional comparative.
  const namedRe = new RegExp(
    `^mat[\\s\\-_]*(${MONTH_NAMES})[\\s\\-_]*'?(\\d{2}|\\d{4})(?:[\\s\\-_]+(ty|ya|2ya|3ya))?$`,
    "i"
  );
  const named = t.match(namedRe);
  if (named) {
    const month = MONTH_INDEX[named[1].toLowerCase()];
    const year = normalizeYear(named[2]);
    const qual = named[3] ? `-${named[3].toUpperCase()}` : "";
    return {
      kind: "mat",
      iso: `MAT-${year}-${pad2(month)}${qual}`,
      confidence: 0.97,
      raw: tok,
    };
  }
  // Numeric "MAT 2024-12 YA".
  const numRe = /^mat[\s\-_]*(\d{4})[\s\-_](\d{1,2})(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const num = t.match(numRe);
  if (num) {
    const qual = num[3] ? `-${num[3].toUpperCase()}` : "";
    return {
      kind: "mat",
      iso: `MAT-${num[1]}-${pad2(Number(num[2]))}${qual}`,
      confidence: 0.97,
      raw: tok,
    };
  }
  // Bare "MAT TY" / "MAT YA" / "MAT 2YA" — comparative without
  // explicit anchor month. Common in Marico India / MENA panels.
  const compRe = /^mat[\s\-_]+(ty|ya|2ya|3ya)$/i;
  const comp = t.match(compRe);
  if (comp) {
    return {
      kind: "mat",
      iso: `MAT-${comp[1].toUpperCase()}`,
      confidence: 0.85,
      raw: tok,
    };
  }
  if (/^mat$/i.test(t)) {
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
  // "YTD TY" / "YTD YA" / "YTD 2YA" — Nielsen comparative qualifiers.
  // TY = this year, YA = year ago, 2YA = two years ago, etc.
  const compYtd = /^ytd[\s\-_]*(ty|ya|2ya|3ya)$/i;
  const compM = t.match(compYtd);
  if (compM) {
    return {
      kind: "ytd",
      iso: `YTD-${compM[1].toUpperCase()}`,
      confidence: 0.92,
      raw: tok,
    };
  }
  if (/^ytd$/i.test(t)) {
    return { kind: "ytd", iso: "YTD", confidence: 0.6, raw: tok };
  }
  return null;
}

// "Latest 12 Mths", "Latest 6 Months", "Latest 12 Mths YA",
// "Latest 12 Mths 2YA", "Latest 4 Wks", "Latest 12 Weeks",
// "Latest 2 Yrs", "Latest 1 Year", "Latest 30 Days" — Nielsen
// rolling-window comparative columns. Also accepts "Last N …" /
// "Trailing N …" / "Rolling N …" as synonyms (used in Indian and
// MENA Marico panels).
//
// ISO: L{N}{M|W|Y|D} for current, L{N}{unit}-{TY|YA|2YA|...} for
// comparatives. The unit letter is M / W / Y / D so the existing
// L52W rolling-window matcher stays distinct (matchRolling fires
// first because matchLatestN requires the leading word).
function matchLatestN(tok: string): PeriodMatch | null {
  const t = tok.trim();
  const re =
    /^(?:latest|last|trailing|rolling)[\s\-_]+(\d{1,3})[\s\-_]+(mths?|months?|wks?|weeks?|yrs?|years?|days?)(?:[\s\-_]+(ty|ya|2ya|3ya))?$/i;
  const m = t.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 365) return null;
  const unitWord = m[2].toLowerCase();
  let unit: "M" | "W" | "Y" | "D";
  if (/^mth|^month/.test(unitWord)) unit = "M";
  else if (/^wk|^week/.test(unitWord)) unit = "W";
  else if (/^yr|^year/.test(unitWord)) unit = "Y";
  else unit = "D";
  const qualifier = m[3] ? `-${m[3].toUpperCase()}` : "";
  return {
    kind: "latest_n",
    iso: `L${n}${unit}${qualifier}`,
    confidence: 0.92,
    raw: tok,
  };
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
function directMatch(t: string): PeriodMatch | null {
  return (
    matchLatestN(t) ||
    matchPeriodToDate(t) ||
    matchMat(t) ||
    matchYtd(t) ||
    matchHalfYear(t) ||
    matchPeriodCode(t) ||
    matchRolling(t) ||
    matchMonthWithYear(t) ||
    matchYearThenMonth(t) ||
    matchQuarter(t) ||
    matchWeek(t) ||
    matchYear(t) ||
    matchBareMonth(t)
  );
}

export function matchPeriod(token: string): PeriodMatch | null {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  const direct = directMatch(trimmed);
  if (direct) return direct;
  // Fallback: strip a trailing "w/e DD/MM/YY" decoration and retry.
  // Handles compound headers like "Q1 23 - w/e 23/03/23" and
  // "Latest 12 Mths 2YA - w/e 23/12/23" where the leading token is
  // the canonical period.
  const stripped = trimmed.replace(WE_DECORATION, "").trim();
  if (stripped && stripped.length < trimmed.length) {
    return directMatch(stripped);
  }
  return null;
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
  matchLatestN,
  matchHalfYear,
  matchPeriodToDate,
  matchPeriodCode,
};
