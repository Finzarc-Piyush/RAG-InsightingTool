/**
 * Wave F3 · Pure-Node statistical-significance tests.
 *
 * Three tests, picked for the analytical-chat use cases:
 *
 *   - **Welch's t-test** (two-sample, unequal variances). Use when
 *     comparing two means: "is the difference in conversion rate
 *     between A and B significant?"
 *
 *   - **Chi-square test** of independence. Use when comparing two
 *     categorical distributions: "do customer segments differ in
 *     product preference?"
 *
 *   - **Paired t-test**. Use when each observation in sample A is
 *     paired with one in sample B (before / after, this-period /
 *     last-period for the same entity).
 *
 * All three return a p-value + test statistic + effect-size hint
 * (Cohen's d for t-tests, Cramér's V for chi-square). Conservative —
 * never returns "significant" without a real test; rejects undersized
 * samples with a clear message.
 *
 * NOT a substitute for a proper scipy-backed implementation when the
 * statistical stakes are high (regulatory submission, A/B-testing
 * platform). This is the "is the difference real or noise?" question
 * users keep asking — and being able to answer it inline is the value.
 */

export type SignificanceTest = "welch_t" | "chi_square" | "paired_t";

export interface WelchTInput {
  test: "welch_t";
  sampleA: number[];
  sampleB: number[];
  /** Significance threshold. Default 0.05. */
  alpha?: number;
}

export interface ChiSquareInput {
  test: "chi_square";
  /** 2D contingency table — rows × columns of observed counts. */
  contingencyTable: number[][];
  alpha?: number;
}

export interface PairedTInput {
  test: "paired_t";
  sampleA: number[];
  sampleB: number[];
  alpha?: number;
}

export type SignificanceInput = WelchTInput | ChiSquareInput | PairedTInput;

export interface SignificanceResult {
  ok: true;
  test: SignificanceTest;
  statistic: number;
  pValue: number;
  /** True iff p < alpha. */
  significant: boolean;
  /** "small" / "medium" / "large" — derived from effect size. */
  effectSize: { value: number; magnitude: "negligible" | "small" | "medium" | "large" };
  /** Degrees of freedom used in the test. */
  df: number;
  /** Sample sizes for reporting. */
  n: { sampleA: number; sampleB?: number };
  /** Short one-line interpretation for the narrator. */
  interpretation: string;
}

export type SignificanceFailure = { ok: false; error: string };

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sampleStd(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const ss = arr.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(ss / (arr.length - 1));
}

function cleanFiniteNumbers(arr: number[]): number[] {
  return arr.filter((v) => typeof v === "number" && Number.isFinite(v));
}

/**
 * Two-sided t-distribution survival function approximation via the
 * Hill (1970) algorithm. Returns Pr(|T| > |t|) for t with df > 0.
 * Accurate to ~5 decimal places for df ≥ 5 — plenty for "is it
 * significant" narrative use.
 */
function tTwoSidedPValue(t: number, df: number): number {
  if (df <= 0) return 1;
  const x = df / (df + t * t);
  // Regularised incomplete beta function I_x(df/2, 1/2) via continued
  // fraction (Abramowitz & Stegun 26.5.8). Inlining keeps this dep-free.
  const p = incompleteBeta(df / 2, 0.5, x);
  // Two-sided: I_x(df/2, 1/2) IS the survival probability.
  return Math.min(1, Math.max(0, p));
}

function logGamma(x: number): number {
  // Lanczos approximation (g=7, n=9), accurate to ~14 digits.
  const g = 7;
  const cof = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = cof[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < 9; i++) {
    a += cof[i]! / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Regularised incomplete beta function I_x(a, b) via the continued
 * fraction expansion (Press et al., Numerical Recipes 6.4).
 */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x === 0 || x === 1) return x;
  if (x < 0 || x > 1) return NaN;
  const lbeta = logBeta(a, b);
  const front =
    Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lbeta) / a;
  // Continued-fraction representation.
  const itMax = 200;
  const eps = 3e-7;
  let f = 1;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;
  for (let m = 1; m <= itMax; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= d * c;
    aa = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    f *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return front * f;
}

/**
 * Chi-square survival function via the regularised upper incomplete
 * gamma function Q(k/2, x/2). Returns Pr(X² > x) for the chi-square
 * distribution with df = k. Standard relation:
 *   Pr(X² > x) = Q(k/2, x/2) = 1 - P(k/2, x/2)
 */
function chiSquarePValue(x: number, df: number): number {
  if (df <= 0 || x < 0) return 1;
  return 1 - regularizedGammaP(df / 2, x / 2);
}

function regularizedGammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  if (x === 0) return 0;
  // Use series expansion for x < a+1, continued fraction otherwise.
  if (x < a + 1) {
    // Series: e^-x * x^a / Gamma(a) * sum (Gamma(a)/Gamma(a+1+n)) * x^n
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 200; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 3e-7) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  } else {
    // Continued fraction
    let b = x + 1 - a;
    let c = 1e30;
    let d = 1 / b;
    let h = d;
    for (let i = 1; i < 200; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c;
      if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 3e-7) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  }
}

/**
 * Map Cohen's d (t-tests) or Cramér's V (chi-square) into a coarse
 * magnitude bucket for narrator-friendly framing.
 */
function bucketCohensD(d: number): SignificanceResult["effectSize"]["magnitude"] {
  const a = Math.abs(d);
  if (a < 0.2) return "negligible";
  if (a < 0.5) return "small";
  if (a < 0.8) return "medium";
  return "large";
}

function bucketCramersV(v: number): SignificanceResult["effectSize"]["magnitude"] {
  if (v < 0.1) return "negligible";
  if (v < 0.3) return "small";
  if (v < 0.5) return "medium";
  return "large";
}

export function runSignificanceTest(
  input: SignificanceInput
): SignificanceResult | SignificanceFailure {
  const alpha = input.alpha ?? 0.05;
  if (input.test === "welch_t") {
    const a = cleanFiniteNumbers(input.sampleA);
    const b = cleanFiniteNumbers(input.sampleB);
    if (a.length < 3 || b.length < 3) {
      return {
        ok: false,
        error: `welch_t: need ≥ 3 finite obs per sample; got nA=${a.length}, nB=${b.length}`,
      };
    }
    const mA = mean(a);
    const mB = mean(b);
    const sA = sampleStd(a);
    const sB = sampleStd(b);
    const seSq = sA ** 2 / a.length + sB ** 2 / b.length;
    if (seSq === 0) {
      // Both samples have zero variance — either identical (no
      // difference, p=1) or perfectly separated (p ≈ 0). Handle both.
      const significant = mA !== mB;
      return {
        ok: true,
        test: "welch_t",
        statistic: significant ? Infinity : 0,
        pValue: significant ? 0 : 1,
        significant,
        effectSize: { value: significant ? Infinity : 0, magnitude: significant ? "large" : "negligible" },
        df: a.length + b.length - 2,
        n: { sampleA: a.length, sampleB: b.length },
        interpretation: significant
          ? `Means are deterministically different (zero within-group variance): ${mA.toFixed(2)} vs ${mB.toFixed(2)}.`
          : `Means are identical: ${mA.toFixed(2)}.`,
      };
    }
    const t = (mA - mB) / Math.sqrt(seSq);
    // Welch–Satterthwaite df.
    const dfNum = seSq ** 2;
    const dfDen =
      ((sA ** 2 / a.length) ** 2) / (a.length - 1) +
      ((sB ** 2 / b.length) ** 2) / (b.length - 1);
    const df = dfDen > 0 ? dfNum / dfDen : a.length + b.length - 2;
    const p = tTwoSidedPValue(t, df);
    // Cohen's d (pooled std).
    const pooled = Math.sqrt(
      ((a.length - 1) * sA ** 2 + (b.length - 1) * sB ** 2) /
        Math.max(1, a.length + b.length - 2)
    );
    const d = pooled === 0 ? 0 : (mA - mB) / pooled;
    const sig = p < alpha;
    return {
      ok: true,
      test: "welch_t",
      statistic: t,
      pValue: p,
      significant: sig,
      effectSize: { value: d, magnitude: bucketCohensD(d) },
      df,
      n: { sampleA: a.length, sampleB: b.length },
      interpretation: `${sig ? "Significant" : "Not significant"} difference: A=${mA.toFixed(2)} vs B=${mB.toFixed(2)} (t=${t.toFixed(2)}, df=${df.toFixed(1)}, p=${p.toFixed(4)}, d=${d.toFixed(2)} — ${bucketCohensD(d)}).`,
    };
  }

  if (input.test === "paired_t") {
    const a = input.sampleA;
    const b = input.sampleB;
    if (a.length !== b.length) {
      return {
        ok: false,
        error: `paired_t: sampleA and sampleB must have the same length; got ${a.length}, ${b.length}`,
      };
    }
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (typeof x !== "number" || typeof y !== "number") continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      diffs.push(x - y);
    }
    if (diffs.length < 3) {
      return {
        ok: false,
        error: `paired_t: need ≥ 3 valid pairs after cleaning; got ${diffs.length}`,
      };
    }
    const md = mean(diffs);
    const sd = sampleStd(diffs);
    if (sd === 0) {
      const sig = md !== 0;
      return {
        ok: true,
        test: "paired_t",
        statistic: sig ? Infinity : 0,
        pValue: sig ? 0 : 1,
        significant: sig,
        effectSize: { value: sig ? Infinity : 0, magnitude: sig ? "large" : "negligible" },
        df: diffs.length - 1,
        n: { sampleA: a.length, sampleB: b.length },
        interpretation: sig
          ? `Constant non-zero difference: ${md.toFixed(2)}.`
          : `All differences are zero — no change.`,
      };
    }
    const t = md / (sd / Math.sqrt(diffs.length));
    const df = diffs.length - 1;
    const p = tTwoSidedPValue(t, df);
    const d = md / sd; // Cohen's d for paired
    const sig = p < alpha;
    return {
      ok: true,
      test: "paired_t",
      statistic: t,
      pValue: p,
      significant: sig,
      effectSize: { value: d, magnitude: bucketCohensD(d) },
      df,
      n: { sampleA: a.length, sampleB: b.length },
      interpretation: `${sig ? "Significant" : "Not significant"} paired difference: mean(A-B)=${md.toFixed(2)} (t=${t.toFixed(2)}, df=${df}, p=${p.toFixed(4)}, d=${d.toFixed(2)} — ${bucketCohensD(d)}).`,
    };
  }

  // chi_square
  const table = input.contingencyTable;
  if (
    !Array.isArray(table) ||
    table.length < 2 ||
    !Array.isArray(table[0]) ||
    table[0].length < 2
  ) {
    return {
      ok: false,
      error: "chi_square: contingency table must be at least 2×2",
    };
  }
  const rows = table.length;
  const cols = table[0].length;
  // Row + column sums.
  const rowSums = table.map((r) => r.reduce((a, b) => a + b, 0));
  const colSums: number[] = Array(cols).fill(0);
  let grandTotal = 0;
  for (const r of table) {
    for (let j = 0; j < cols; j++) {
      colSums[j]! += r[j]!;
      grandTotal += r[j]!;
    }
  }
  if (grandTotal === 0) {
    return {
      ok: false,
      error: "chi_square: contingency table is empty (grand total = 0)",
    };
  }
  let chi2 = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const expected = (rowSums[i]! * colSums[j]!) / grandTotal;
      if (expected === 0) continue;
      const diff = table[i]![j]! - expected;
      chi2 += (diff * diff) / expected;
    }
  }
  const df = (rows - 1) * (cols - 1);
  const p = chiSquarePValue(chi2, df);
  // Cramér's V effect size.
  const k = Math.min(rows, cols) - 1;
  const v = k > 0 ? Math.sqrt(chi2 / (grandTotal * k)) : 0;
  const sig = p < alpha;
  return {
    ok: true,
    test: "chi_square",
    statistic: chi2,
    pValue: p,
    significant: sig,
    effectSize: { value: v, magnitude: bucketCramersV(v) },
    df,
    n: { sampleA: grandTotal },
    interpretation: `${sig ? "Significant" : "Not significant"} association: χ²=${chi2.toFixed(2)}, df=${df}, p=${p.toFixed(4)}, V=${v.toFixed(2)} — ${bucketCramersV(v)}.`,
  };
}
