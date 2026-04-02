import type { TemporalFacetColumnMeta } from '@/shared/schema';
import { parseDateLike } from '@/lib/parseDateLike';
import { pivotDimensionStringKey } from '@/lib/pivot/pivotDimensionStringKey';

const MS_PER_DAY = 86400000;

function dateFromNumericCell(raw: number): Date | null {
  if (!Number.isFinite(raw)) return null;
  if (raw > 1e12 && raw < 4e12) return new Date(raw);
  if (raw > 1e9 && raw < 1e12) return new Date(raw * 1000);
  if (raw >= 20000 && raw <= 60000) {
    const d = new Date(Math.round((raw - 25569) * MS_PER_DAY));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Aligns with server `temporalFacetColumns.parseRowDate` / preview bucketing. */
function parseDateForTemporalFacet(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = dateFromNumericCell(raw);
    if (d) return d;
  }
  const ts = parseDateLike(raw);
  if (ts !== null) return new Date(ts);
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    if (y >= 1900 && y <= 2100) return new Date(y, 0, 1);
  }
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day) return d;
    }
  }
  const t = Date.parse(s);
  if (!isNaN(t)) return new Date(t);
  return null;
}

/** ISO week key `YYYY-Www` — matches server `isoWeekKeyAndLabel`. */
function isoWeekNormalizedKey(d: Date): string {
  const t = new Date(d.getTime());
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const isoYear = t.getFullYear();
  const week1 = new Date(isoYear, 0, 4);
  const w =
    1 +
    Math.round(
      ((t.getTime() - week1.getTime()) / MS_PER_DAY - 3 + ((week1.getDay() + 6) % 7)) / 7
    );
  return `${isoYear}-W${String(w).padStart(2, '0')}`;
}

function normalizedFacetKeyFromDate(d: Date, grain: TemporalFacetColumnMeta['grain']): string {
  const year = d.getFullYear();
  const month = d.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const day = d.getDate();
  switch (grain) {
    case 'year':
      return `${year}`;
    case 'quarter':
      return `${year}-Q${quarter}`;
    case 'month':
      return `${year}-${String(month + 1).padStart(2, '0')}`;
    case 'date':
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    case 'week':
      return isoWeekNormalizedKey(d);
    case 'half_year':
      return `${year}-H${month < 6 ? 1 : 2}`;
    default:
      return '';
  }
}

function isLikelyNormalizedFacetKey(s: string, grain: TemporalFacetColumnMeta['grain']): boolean {
  switch (grain) {
    case 'year':
      return /^\d{4}$/.test(s);
    case 'month':
      return /^\d{4}-\d{2}$/.test(s);
    case 'quarter':
      return /^\d{4}-Q[1-4]$/.test(s);
    case 'half_year':
      return /^\d{4}-H[12]$/.test(s);
    case 'week':
      return /^\d{4}-W\d{1,2}$/.test(s);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(s);
    default:
      return false;
  }
}

function rawCellForTemporalFacet(
  row: Record<string, unknown>,
  field: string,
  meta: TemporalFacetColumnMeta
): unknown {
  const direct = row[field];
  if (direct !== null && direct !== undefined && String(direct).trim() !== '') {
    return direct;
  }
  const src = row[meta.sourceColumn];
  if (src !== null && src !== undefined && String(src).trim() !== '') return src;
  const cleanedKey = `Cleaned_${meta.sourceColumn}`;
  return row[cleanedKey];
}

export function buildTemporalFacetMetaByFieldName(
  metas: TemporalFacetColumnMeta[] | undefined | null
): Map<string, TemporalFacetColumnMeta> {
  const m = new Map<string, TemporalFacetColumnMeta>();
  for (const meta of metas ?? []) {
    if (meta?.name) m.set(meta.name, meta);
  }
  return m;
}

/**
 * Dimension key for one pivot field on a row. For temporal facet columns, derives the same
 * normalized bucket key as the server when the row only has the source date column populated.
 */
export function pivotRowDimensionKey(
  row: Record<string, unknown>,
  field: string,
  facetMetaByFieldName: Map<string, TemporalFacetColumnMeta> | undefined
): string {
  const meta = facetMetaByFieldName?.get(field);
  if (!meta) {
    return pivotDimensionStringKey(row[field]);
  }
  const raw = rawCellForTemporalFacet(row, field, meta);
  if (raw === null || raw === undefined) return '';
  const str = String(raw).trim();
  if (str === '') return '';
  if (isLikelyNormalizedFacetKey(str, meta.grain)) return str;
  const d = parseDateForTemporalFacet(raw);
  if (!d) return '';
  return normalizedFacetKeyFromDate(d, meta.grain);
}

export function distinctPivotFilterKeysFromRows(
  data: Record<string, unknown>[],
  field: string,
  facetMetaByFieldName: Map<string, TemporalFacetColumnMeta>
): string[] {
  const s = new Set<string>();
  for (const r of data) {
    s.add(pivotRowDimensionKey(r, field, facetMetaByFieldName));
  }
  return [...s].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
