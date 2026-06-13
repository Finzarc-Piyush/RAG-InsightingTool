/**
 * Pure chart filter / formatting helpers shared by the chart renderer and the
 * full-screen chart modals. Extracted verbatim (Wave B8/B9) from
 * `ChartRenderer.tsx`, `ChartModal.tsx`, and `ChartOnlyModal.tsx`, which each
 * carried byte-identical copies. These are pure functions — behavior is
 * unchanged from the inlined originals.
 */

import { format as formatDate } from 'date-fns';

/** Format an ISO-ish date string as `d MMM yyyy`, or undefined when unparseable. */
export const formatDateForDisplay = (value?: string) => {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return formatDate(parsed, 'd MMM yyyy');
};

/** Pick a sensible slider step for a [min, max] numeric range. */
export const determineSliderStep = (min: number, max: number) => {
  const range = Math.abs(max - min);
  if (!Number.isFinite(range) || range === 0) return 1;
  if (range <= 0.1) return 0.001;
  if (range <= 1) return 0.01;
  if (range <= 10) return 0.1;
  if (range <= 100) return 1;
  return Math.pow(10, Math.floor(Math.log10(range)) - 1);
};

/** Coerce an arbitrary cell value to a finite number, or NaN. */
export const parseNumericValue = (value: any): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : NaN;
  }
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,%]/g, '').trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
};

/** Extract the finite numeric values for `key` across `rows`. */
export const getNumericValues = (rows: Record<string, any>[], key?: string | null) => {
  if (!key) return [];
  return rows
    .map((row) => parseNumericValue(row?.[key]))
    .filter((val) => Number.isFinite(val)) as number[];
};

/** Compute a padded [min, max] axis domain from a list of values. */
export const getDynamicDomain = (values: number[], paddingFraction: number = 0.1) => {
  if (!values.length) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.1, 5);
    return [min - pad, max + pad] as [number, number];
  }
  const range = max - min;
  const padding = Math.max(range * paddingFraction, 2);
  return [min - padding, max + padding] as [number, number];
};

/**
 * Field-blind smart axis-label formatter: small decimals → 4dp, sub-1000
 * decimals → 2dp, then K/M/B suffixes at 1dp. This is the legacy field-AGNOSTIC
 * formatter; the field-AWARE `makeAxisTickFormatter` in `format.ts` is separate
 * and unaffected.
 */
export const formatAxisLabelFieldBlind = (value: number): string => {
  if (Math.abs(value) < 0.01 && value !== 0) {
    return value.toFixed(4);
  }
  if (Math.abs(value) < 1000 && value % 1 !== 0) {
    return value.toFixed(2);
  }
  const absValue = Math.abs(value);
  if (absValue >= 1e9) {
    return (value / 1e9).toFixed(1) + 'B';
  } else if (absValue >= 1e6) {
    return (value / 1e6).toFixed(1) + 'M';
  } else if (absValue >= 1e3) {
    return (value / 1e3).toFixed(1) + 'K';
  }
  return value.toFixed(0);
};
