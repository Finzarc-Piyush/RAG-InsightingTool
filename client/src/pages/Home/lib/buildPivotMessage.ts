import type { Message, PivotDefaults, PivotState } from '@/shared/schema';
import type { PivotBuilderAddPayload } from '@/pages/Home/Components/DataPreviewTable';

/**
 * Wave PB · construct a chat message that carries a user-built pivot so the
 * existing MessageBubble → DataPreviewTable (variant="analysis") path renders
 * it as an editable pivot. Mirrors `handleAppendAssistantChart`, which appends
 * a chart-only message.
 *
 * `pivotState` (analysisView:'pivot' + the built config) drives hydration;
 * `pivotDefaults` (dataSource:'base') tells the in-chat pivot to re-aggregate
 * the full session dataset via `pivotQuery`; `preview` rows make the message
 * pivot-eligible (`computeAllowPivotAutoShow`) and seed the flat view.
 *
 * The message is LOCAL-only (never persisted server-side, same as locally
 * added charts), so it carries a `localPivot` marker — MessageBubble omits
 * `messageTimestamp` for these so the pivot-state PATCH (which would 404 on a
 * message that doesn't exist server-side) is skipped. The pivot still renders
 * and edits in-session; durable persistence is a follow-up.
 */
export type LocalPivotMessage = Message & { localPivot: true };

export function buildPivotMessage(
  payload: PivotBuilderAddPayload,
  timestamp: number,
): LocalPivotMessage {
  const { config, filterSelections, previewRows } = payload;

  const valueAggregators: NonNullable<PivotDefaults['valueAggregators']> = {};
  for (const v of config.values) {
    if (v.agg !== 'first') valueAggregators[v.field] = v.agg;
  }

  const hasFilterSelections = Object.keys(filterSelections).length > 0;

  const pivotDefaults: PivotDefaults = {
    rows: config.rows,
    columns: config.columns,
    values: config.values.map((v) => v.field),
    filterFields: config.filters,
    ...(hasFilterSelections ? { filterSelections } : {}),
    ...(Object.keys(valueAggregators).length ? { valueAggregators } : {}),
    dataSource: 'base',
  };

  const pivotState: PivotState = {
    schemaVersion: 1,
    config: {
      rows: config.rows,
      columns: config.columns,
      values: config.values.map((v) => ({
        id: v.id,
        field: v.field,
        agg: v.agg as 'sum' | 'mean' | 'count' | 'min' | 'max',
      })),
      filters: config.filters,
      unused: config.unused,
      ...(config.rowSort ? { rowSort: config.rowSort } : {}),
    },
    ...(hasFilterSelections ? { filterSelections } : {}),
    analysisView: 'pivot',
  };

  return {
    role: 'assistant',
    content: 'Pivot from Pivot Builder',
    preview: previewRows as Message['preview'],
    pivotDefaults,
    pivotState,
    timestamp,
    localPivot: true,
  } as LocalPivotMessage;
}
