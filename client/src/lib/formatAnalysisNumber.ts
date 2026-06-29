/**
 * Analysis table numeric display: integers for |n| ≥ 10, decimals when smaller.
 */
export function formatAnalysisNumber(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  const abs = Math.abs(n);
  if (abs >= 10) {
    return Math.round(n).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });
  }
  const s = n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// CQ-5 · parseNumericCell now lives in server/shared (one definition shared by
// both runtimes). Re-exported here so existing client import sites are unchanged.
export { parseNumericCell } from '../../../server/shared/parseNumericCell';
