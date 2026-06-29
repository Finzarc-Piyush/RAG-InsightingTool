/**
 * ExcelJS cell-value coercion, extracted from `excelReader.ts` so the
 * table-structure grid builder can reuse the EXACT same value/label logic
 * without an import cycle (excelReader → tableStructure → grid → here).
 *
 * Reproduces the values the former SheetJS `sheet_to_json({raw:false,
 * defval:null})` produced; see `excelReader.ts` header for the signed-off
 * deltas (dates → real `Date`, percent cells re-stringified to display form).
 */
import ExcelJS from 'exceljs';

/** Count digit placeholders after the decimal point (before the `%`). */
function percentDecimals(numFmt: string): number {
  const beforePct = numFmt.split('%')[0] ?? '';
  const dot = beforePct.lastIndexOf('.');
  if (dot < 0) return 0;
  return (beforePct.slice(dot + 1).match(/[0#]/g) || []).length;
}

/**
 * Reproduce SheetJS `raw:false` display text for a percent-formatted number:
 * scale ×100, round to the format's decimal count, append "%". Optional
 * thousands grouping when the format groups the integer part.
 */
function formatPercentDisplay(value: number, numFmt: string): string {
  const decimals = percentDecimals(numFmt);
  const fixed = (value * 100).toFixed(decimals);
  const beforePct = numFmt.split('%')[0] ?? '';
  if (/[#0],[#0]/.test(beforePct)) {
    const neg = fixed.startsWith('-');
    const [intPart, fracPart] = (neg ? fixed.slice(1) : fixed).split('.');
    const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${neg ? '-' : ''}${fracPart ? `${grouped}.${fracPart}` : grouped}%`;
  }
  return `${fixed}%`;
}

/** Map a resolved ExcelJS cell value to the value fileParser expects. */
export function normalizeValue(v: ExcelJS.CellValue, numFmt: string | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v; // (1) dates typed
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (numFmt && numFmt.includes('%')) return formatPercentDisplay(v, numFmt); // (2)
    return v;
  }
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return normalizeValue(o.result as ExcelJS.CellValue, numFmt); // formula
    if ('error' in o) return null; // error cell → empty
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? '').join('');
    }
    if (typeof o.text === 'string') return o.text; // hyperlink
  }
  return null;
}

/** Header label for a cell, mirroring SheetJS key derivation. */
export function headerLabel(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return cell.text ?? null;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o && o.result != null) return String(o.result);
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? '').join('');
    }
    if (typeof o.text === 'string') return o.text;
  }
  return cell.text || null;
}
