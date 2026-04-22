// Pure math functions for correlation analysis — no LLM/OpenAI dependency.
// Importable by tests without needing Azure OpenAI env vars.

export interface CorrelationResult {
  variable: string;
  correlation: number;
  nPairs?: number;
}

export function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return NaN;
  const cleaned = String(value).replace(/[%,]/g, '').trim();
  return Number(cleaned);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return NaN;

  const sumX = x.slice(0, n).reduce((a, b) => a + b, 0);
  const sumY = y.slice(0, n).reduce((a, b) => a + b, 0);
  const sumXY = x.slice(0, n).reduce((sum, xi, i) => sum + xi * y[i], 0);
  const sumX2 = x.slice(0, n).reduce((sum, xi) => sum + xi * xi, 0);
  const sumY2 = y.slice(0, n).reduce((sum, yi) => sum + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denominator === 0 ? NaN : numerator / denominator;
}

export function calculateCorrelations(
  data: Record<string, any>[],
  targetVariable: string,
  numericColumns: string[]
): CorrelationResult[] {
  const correlations: CorrelationResult[] = [];

  const targetValuesAllRows = data.map((row) => toNumber(row[targetVariable]));
  const hasAnyTarget = targetValuesAllRows.some((v) => !isNaN(v));
  if (!hasAnyTarget) return [];

  for (const col of numericColumns) {
    if (col === targetVariable) continue;

    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < data.length; i++) {
      const tv = targetValuesAllRows[i];
      const cv = toNumber(data[i][col]);
      if (!isNaN(tv) && !isNaN(cv)) {
        x.push(tv);
        y.push(cv);
      }
    }

    if (x.length === 0) continue;

    const correlation = pearsonCorrelation(x, y);
    if (!isNaN(correlation)) {
      correlations.push({ variable: col, correlation, nPairs: x.length });
    }
  }

  return correlations;
}

export function calculateEtaSquared(
  data: Record<string, any>[],
  targetVariable: string,
  categoricalColumn: string
): CorrelationResult | null {
  const pairs: { group: string; value: number }[] = [];
  for (const row of data) {
    const v = toNumber(row[targetVariable]);
    const g = row[categoricalColumn];
    if (!isNaN(v) && g != null && String(g).trim() !== '') {
      pairs.push({ group: String(g), value: v });
    }
  }
  if (pairs.length < 5) return null;

  const groups = new Map<string, number[]>();
  for (const { group, value } of pairs) {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(value);
  }
  if (groups.size < 2) return null;

  const grandMean = pairs.reduce((s, p) => s + p.value, 0) / pairs.length;
  const ssTotal = pairs.reduce((s, p) => s + (p.value - grandMean) ** 2, 0);
  if (ssTotal === 0) return null;

  let ssBetween = 0;
  for (const [, vals] of groups) {
    const gm = vals.reduce((s, v) => s + v, 0) / vals.length;
    ssBetween += vals.length * (gm - grandMean) ** 2;
  }

  // η (correlation ratio) = sqrt(SS_between / SS_total), range 0–1
  const eta = Math.sqrt(ssBetween / ssTotal);
  return isNaN(eta) ? null : { variable: categoricalColumn, correlation: eta, nPairs: pairs.length };
}

export function calculateCategoricalCorrelations(
  data: Record<string, any>[],
  targetVariable: string,
  categoricalColumns: string[]
): CorrelationResult[] {
  const results: CorrelationResult[] = [];
  for (const col of categoricalColumns) {
    const r = calculateEtaSquared(data, targetVariable, col);
    if (r !== null) results.push(r);
  }
  return results;
}
