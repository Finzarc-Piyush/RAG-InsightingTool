/**
 * Estimate an Excel worksheet's row count from its range/ref string
 * (e.g. "A1:Z500000") WITHOUT materializing cell data. Returns 0 when the ref
 * is missing/unparseable. Pure + unit-testable; used as a pre-parse OOM guard.
 *
 * Extracted to its own module (Wave R8) so the ExcelJS reader and fileParser
 * can both depend on it without a circular import.
 */
export function estimateExcelRowsFromRef(ref: string | undefined | null): number {
  if (!ref || typeof ref !== 'string') return 0;
  const parts = ref.split(':');
  const rowNum = (cell: string): number => {
    const m = /(\d+)\s*$/.exec((cell ?? '').trim());
    return m ? parseInt(m[1], 10) : NaN;
  };
  if (parts.length < 2) {
    return Number.isFinite(rowNum(parts[0] ?? '')) ? 1 : 0;
  }
  const start = rowNum(parts[0]);
  const end = rowNum(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start + 1;
}
