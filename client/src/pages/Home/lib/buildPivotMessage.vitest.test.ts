import { describe, expect, it } from 'vitest';
import { buildPivotMessage } from './buildPivotMessage';
import type { PivotBuilderAddPayload } from '@/pages/Home/Components/DataPreviewTable';

/**
 * Wave PB · the Pivot Builder's "Add to chat" appends the message produced
 * here. It must be shaped so MessageBubble → DataPreviewTable renders it as an
 * editable pivot: pivot-eligible (preview rows), hydratable (pivotState with
 * analysisView:'pivot'), and seeded (pivotDefaults, dataSource:'base').
 */
const payload: PivotBuilderAddPayload = {
  config: {
    filters: ['Region'],
    columns: ['Brand'],
    rows: ['Quarter'],
    values: [{ id: 'meas_Sales', field: 'Sales', agg: 'sum' }],
    unused: ['Channel'],
    rowSort: { byValueSpecId: 'meas_Sales', direction: 'desc', primary: 'measure' },
  },
  filterSelections: { Region: ['North', 'South'] },
  previewRows: [
    { Quarter: 'Q1', Brand: 'Marico', Sales: 100 },
    { Quarter: 'Q2', Brand: 'Marico', Sales: 110 },
  ],
};

describe('buildPivotMessage', () => {
  it('produces an assistant pivot message that will render + hydrate', () => {
    const msg = buildPivotMessage(payload, 1700000000000);

    expect(msg.role).toBe('assistant');
    expect(msg.timestamp).toBe(1700000000000);
    // Local-only marker so MessageBubble skips the server pivot-state PATCH.
    expect((msg as { localPivot?: boolean }).localPivot).toBe(true);

    // Preview rows make it pivot-eligible (computeAllowPivotAutoShow).
    expect(Array.isArray(msg.preview)).toBe(true);
    expect(msg.preview?.length).toBe(2);

    // pivotState drives hydration into the pivot view.
    expect(msg.pivotState?.analysisView).toBe('pivot');
    expect(msg.pivotState?.config.rows).toEqual(['Quarter']);
    expect(msg.pivotState?.config.columns).toEqual(['Brand']);
    expect(msg.pivotState?.config.values).toEqual([
      { id: 'meas_Sales', field: 'Sales', agg: 'sum' },
    ]);
    expect(msg.pivotState?.filterSelections).toEqual({ Region: ['North', 'South'] });

    // pivotDefaults seeds the in-chat pivot to re-query the full dataset.
    expect(msg.pivotDefaults?.dataSource).toBe('base');
    expect(msg.pivotDefaults?.rows).toEqual(['Quarter']);
    expect(msg.pivotDefaults?.values).toEqual(['Sales']);
    expect(msg.pivotDefaults?.filterFields).toEqual(['Region']);
    expect(msg.pivotDefaults?.valueAggregators).toEqual({ Sales: 'sum' });
  });

  it('omits empty filter selections', () => {
    const msg = buildPivotMessage(
      { ...payload, filterSelections: {} },
      1700000000001,
    );
    expect(msg.pivotState?.filterSelections).toBeUndefined();
    expect(msg.pivotDefaults?.filterSelections).toBeUndefined();
  });
});
