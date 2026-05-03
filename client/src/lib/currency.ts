// Currency-aware number formatting for the client.
// Uses Intl.NumberFormat with style: 'currency'. The ISO code on a
// column comes from the server-side detector (WF2) plus optional
// LLM disambiguation (WF8). Falls back to plain number formatting
// when ISO is missing/invalid.

import type { ColumnCurrency } from '@/shared/schema';

export type { ColumnCurrency };

/** Full-precision currency string, e.g. "đ131,110,877,074". */
export function formatCurrency(
  value: number | null | undefined,
  currency: ColumnCurrency | undefined,
  locale: string = 'en-US'
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (!currency || !currency.isoCode) {
    return value.toLocaleString(locale);
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.isoCode,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch {
    // Invalid ISO code fallback — render symbol + magnitude manually.
    const formatted = value.toLocaleString(locale, {
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    });
    return currency.position === 'suffix'
      ? `${formatted} ${currency.symbol}`
      : `${currency.symbol}${formatted}`;
  }
}

/** Compact form for tooltip / axis labels: "đ131B", "$1.2M". */
export function formatCurrencyCompact(
  value: number | null | undefined,
  currency: ColumnCurrency | undefined,
  locale: string = 'en-US'
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (!currency || !currency.isoCode) {
    return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value
    );
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency.isoCode,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    const compact = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
    return currency.position === 'suffix'
      ? `${compact} ${currency.symbol}`
      : `${currency.symbol}${compact}`;
  }
}
