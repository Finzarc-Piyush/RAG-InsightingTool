import type { PivotState } from '@/shared/schema';

const MAX_LEN = 64;

const AGG_LABEL: Record<PivotState['config']['values'][number]['agg'], string> = {
  sum: 'Sum',
  mean: 'Avg',
  count: 'Count',
  min: 'Min',
  max: 'Max',
};

function truncate(s: string): string {
  if (s.length <= MAX_LEN) return s;
  return `${s.slice(0, MAX_LEN - 1)}…`;
}

/**
 * Render-time pivot label derived from its config (rows × columns × values).
 * Persist only the user's `customName` override; this is recomputed on every
 * render so config edits update the sidebar live.
 *
 * Returns null when the config has no usable signal (caller should fall back
 * to its own ordinal label).
 */
export function pivotAutoName(
  config: PivotState['config'] | undefined | null
): string | null {
  if (!config) return null;
  const rows = config.rows ?? [];
  const cols = config.columns ?? [];
  const values = config.values ?? [];

  if (values.length === 0 && rows.length === 0 && cols.length === 0) {
    return 'Empty pivot';
  }

  if (values.length === 0) {
    const dims = [...rows, ...cols];
    return truncate(`Count by ${dims.join(' × ')}`);
  }

  if (values.length === 1) {
    const v = values[0];
    const head = `${AGG_LABEL[v.agg]} of ${v.field}`;
    if (rows.length === 0 && cols.length === 0) return truncate(head);
    if (rows.length === 0) return truncate(`${head} × ${cols.join(' × ')}`);
    const byRows = ` by ${rows.join(', ')}`;
    const xCols = cols.length ? ` × ${cols.join(' × ')}` : '';
    return truncate(`${head}${byRows}${xCols}`);
  }

  // ≥2 values
  if (rows.length === 0 && cols.length === 0) {
    const head = values
      .slice(0, 2)
      .map((v) => v.field)
      .join(', ');
    const more = values.length > 2 ? `, +${values.length - 2} more` : '';
    return truncate(`${head}${more}`);
  }
  const dims = [...rows, ...cols].join(' × ');
  return truncate(`${values.length} measures by ${dims}`);
}
