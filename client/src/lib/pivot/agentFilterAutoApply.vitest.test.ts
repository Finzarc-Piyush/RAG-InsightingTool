import { describe, expect, it } from 'vitest';
import {
  createInitialPivotConfig,
  syncFilterSelectionsWithFilters,
} from '@/lib/pivot/buildPivotModel';
import type {
  FilterDistinctProvenanceRef,
  FilterDistinctSnapshotRef,
} from '@/lib/pivot/buildPivotModel';
import type { FilterSelections } from '@/lib/pivot/types';

/** Inlined isAll-omit predicate from DataPreviewTable.tsx:790-794. */
function wouldEmitFieldInPayload(
  selection: Set<string>,
  snapshot: Set<string>
): boolean {
  if (selection.size !== snapshot.size) return true;
  for (const v of selection) {
    if (!snapshot.has(v)) return true;
  }
  return false;
}

/**
 * Pins the end-to-end behavior the user explicitly asked us to guarantee:
 * "if the question user asked required the filter application, would the
 * pivot section have this done by default?"
 *
 * Simulates the server having sent a `pivotDefaults` envelope of the shape
 * produced by `pivotSliceDefaultsFromDimensionFilters` for the question
 * "show sales for FEMALE SHOWER GEL only", and asserts that:
 *   1. The FILTERS shelf includes Products as a chip.
 *   2. `filterSelections.Products` is a Set containing exactly
 *      `["FEMALE SHOWER GEL"]`.
 */
describe('agent dimension filter → pivot FILTERS shelf auto-apply', () => {
  const allFieldKeys = ['Products', 'Region', 'Month', 'Sales'];
  const numericKeys = ['Sales'];
  // Server-supplied defaults (the message envelope's `pivotDefaults` field).
  const pivotDefaults = {
    rows: ['Region'],
    columns: ['Month'],
    values: ['Sales'],
    filterFields: ['Products'],
    filterSelections: { Products: ['FEMALE SHOWER GEL'] } as Record<
      string,
      string[]
    >,
  };

  it('createInitialPivotConfig adds the agent-filtered field to config.filters', () => {
    const config = createInitialPivotConfig(
      allFieldKeys,
      numericKeys,
      pivotDefaults.rows,
      pivotDefaults.values,
      {
        defaultFilterKeys: pivotDefaults.filterFields,
        defaultColumnKeys: pivotDefaults.columns,
      }
    );
    expect(config.filters).toContain('Products');
    expect(config.rows).toEqual(['Region']);
    expect(config.columns).toEqual(['Month']);
    // Sanity: the field shouldn't appear twice in different shelves.
    expect(config.unused).not.toContain('Products');
    expect(config.rows).not.toContain('Products');
  });

  it('syncFilterSelectionsWithFilters hydrates the agent hint into the Set state when the value is in the full distincts', () => {
    const initialPrev: FilterSelections = {};
    const next = syncFilterSelectionsWithFilters(
      [
        { Products: 'FEMALE SHOWER GEL', Region: 'East', Sales: 100 },
        { Products: 'FEMALE SHOWER GEL', Region: 'West', Sales: 80 },
      ],
      ['Products'],
      initialPrev,
      undefined,
      null,
      // Full DuckDB distincts include the agent-filtered value alongside
      // the rest of the dimension's universe.
      {
        Products: [
          'FEMALE SHOWER GEL',
          'MARICO',
          'PURITE',
          'OLIV',
          'LASHE',
        ],
      },
      pivotDefaults.filterSelections
    );
    expect(next.Products).toBeInstanceOf(Set);
    expect([...(next.Products as Set<string>)]).toEqual(['FEMALE SHOWER GEL']);
  });

  it('round-trip is correct: selection equals snapshot → isAll-omit drops the field from the payload (server returns all)', () => {
    // This is the contract the FILTERS shelf relies on for the "no hint, all
    // checked" case: the user has done nothing, the popover shows all values
    // checked, the snapshot equals the selection, and the pivot query payload
    // omits the field entirely so the server doesn't apply a no-op IN filter.
    const snap = { current: { Region: new Set<string>() } };
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Region'],
      {},
      snap,
      null,
      { Region: ['East', 'West', 'Central', 'South'] },
      null
    );
    const selection = next.Region!;
    const snapshot = snap.current.Region;
    // Selection equals snapshot ⇒ DataPreviewTable's payload builder skips
    // emitting the field (see filterSelectionsPayload loop, isAll branch).
    expect(selection.size).toBe(snapshot.size);
    expect([...selection].sort()).toEqual([...snapshot].sort());
  });

  it('race scenario: agent dimensionFilter survives the sample → authoritative distincts upgrade and the pivot payload still emits the field', () => {
    // Reproduces the exact race the user reported: a new chat message arrives,
    // pivotDataSignature changes, the reset effect zeroes the snapshot+prov
    // refs, and two effects then race:
    //   • Effect A fetches /pivot/fields and populates sessionFilterDistincts.
    //   • Effect B calls syncFilterSelectionsWithFilters synchronously.
    // Effect B fires first with empty datasetDistincts → falls back to the
    // agent's filtered preview rows (which only contain the filtered value).
    // When Effect A resolves and Effect B re-runs, the merge-new-distincts
    // branch used to silently broaden the selection to the full universe and
    // the isAll-omit check then dropped the field from the payload entirely.
    // Provenance tracking now blocks that broadening.
    const snap: FilterDistinctSnapshotRef = { current: {} };
    const prov: FilterDistinctProvenanceRef = { current: {} };

    // The agent's filtered preview rows — only one Product survived its
    // dimensionFilter, so the row sample is effectively `{FEMALE SHOWER GEL}`.
    const previewRows = [
      { Products: 'FEMALE SHOWER GEL', Region: 'East', Sales: 100 },
      { Products: 'FEMALE SHOWER GEL', Region: 'West', Sales: 80 },
    ];
    const initialSelections = pivotDefaults.filterSelections;

    // Effect B's first run, pre-fetch.
    const afterSampleSync = syncFilterSelectionsWithFilters(
      previewRows,
      ['Products'],
      {},
      snap,
      null,
      {}, // sessionFilterDistincts not yet loaded
      initialSelections,
      prov
    );
    expect([...(afterSampleSync.Products as Set<string>)]).toEqual([
      'FEMALE SHOWER GEL',
    ]);
    expect(prov.current.Products).toBe('sample');

    // Effect A resolves. Effect B re-runs with the now-authoritative full
    // distincts. The agent's filter intent must survive.
    const afterAuthoritativeSync = syncFilterSelectionsWithFilters(
      previewRows,
      ['Products'],
      afterSampleSync,
      snap,
      null,
      {
        Products: [
          'FEMALE SHOWER GEL',
          'MARICO',
          'PURITE',
          'OLIV',
          'LASHE',
        ],
      },
      initialSelections,
      prov
    );
    expect([...(afterAuthoritativeSync.Products as Set<string>)]).toEqual([
      'FEMALE SHOWER GEL',
    ]);
    expect(prov.current.Products).toBe('authoritative');

    // Smoking-gun: the pivot payload builder emits the field (selection
    // narrower than snapshot), so the server applies the IN filter and
    // returns only FEMALE SHOWER GEL rows.
    expect(
      wouldEmitFieldInPayload(
        afterAuthoritativeSync.Products as Set<string>,
        snap.current.Products
      )
    ).toBe(true);
  });

  it('WPF7 Metric pre-fill survives the same race (compound-shape wide-format dataset)', () => {
    // Server pre-fills `Metric: ['Value Sales']` into pivotDefaults for
    // compound-shape wide-format-melted datasets so the default render
    // doesn't silently SUM across mixed metrics. Same race shape, different
    // field. Proves the fix is field-agnostic.
    const snap: FilterDistinctSnapshotRef = { current: {} };
    const prov: FilterDistinctProvenanceRef = { current: {} };
    const wpf7Hint: Record<string, string[]> = {
      Metric: ['Value Sales'],
    };
    // Agent's preview rows for a wide-format compound shape often contain
    // only one metric value because the WPF2 compound-guard injected
    // `Metric IN ['Value Sales']` into the planner step.
    const wideFormatPreviewRows = [
      { Metric: 'Value Sales', Period: '2023-Q1', Value: 100 },
      { Metric: 'Value Sales', Period: '2023-Q2', Value: 110 },
    ];

    const afterSampleSync = syncFilterSelectionsWithFilters(
      wideFormatPreviewRows,
      ['Metric'],
      {},
      snap,
      null,
      {},
      wpf7Hint,
      prov
    );
    expect([...(afterSampleSync.Metric as Set<string>)]).toEqual([
      'Value Sales',
    ]);
    expect(prov.current.Metric).toBe('sample');

    const afterAuthoritativeSync = syncFilterSelectionsWithFilters(
      wideFormatPreviewRows,
      ['Metric'],
      afterSampleSync,
      snap,
      null,
      // Full DuckDB distincts for the Metric column.
      { Metric: ['Value Sales', 'Volume', 'Distribution', 'Price'] },
      wpf7Hint,
      prov
    );
    expect([...(afterAuthoritativeSync.Metric as Set<string>)]).toEqual([
      'Value Sales',
    ]);
    expect(prov.current.Metric).toBe('authoritative');
    expect(
      wouldEmitFieldInPayload(
        afterAuthoritativeSync.Metric as Set<string>,
        snap.current.Metric
      )
    ).toBe(true);
  });
});
