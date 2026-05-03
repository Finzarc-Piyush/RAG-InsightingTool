import { describe, expect, it } from 'vitest';
import { syncFilterSelectionsWithFilters } from '@/lib/pivot/buildPivotModel';
import type {
  FilterDistinctProvenanceRef,
  FilterDistinctSnapshotRef,
} from '@/lib/pivot/buildPivotModel';
import type { FilterSelections } from '@/lib/pivot/types';

const NO_PREV: FilterSelections = {};

/**
 * Inlined copy of the `isAll → omit` predicate at DataPreviewTable.tsx:790-794
 * (and the chart variant at 826-831). When `selection.size === snapshot.size`
 * and every selection value is in the snapshot, the pivot payload builder
 * omits the field entirely so the server doesn't apply a no-op IN filter
 * and instead returns the unfiltered dataset. The provenance-aware sync
 * keeps this predicate sound by ensuring the snapshot reflects authoritative
 * distincts (not a stale sample-derived snapshot).
 */
function wouldOmitFromPayload(
  selection: Set<string>,
  snapshot: Set<string>
): boolean {
  if (selection.size !== snapshot.size) return false;
  for (const v of selection) {
    if (!snapshot.has(v)) return false;
  }
  return true;
}

describe('syncFilterSelectionsWithFilters', () => {
  it('no hint → auto-fills with the full authoritative distincts', () => {
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Region'],
      NO_PREV,
      undefined,
      null,
      { Region: ['East', 'West', 'Central', 'South'] },
      null
    );
    expect(next.Region).toBeInstanceOf(Set);
    expect([...(next.Region as Set<string>)].sort()).toEqual([
      'Central',
      'East',
      'South',
      'West',
    ]);
  });

  it('agent hint that intersects distincts → narrows to the intersection', () => {
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Products'],
      NO_PREV,
      undefined,
      null,
      { Products: ['SHAMPOO', 'CONDITIONER', 'OIL'] },
      { Products: ['SHAMPOO', 'OIL', 'NONEXISTENT'] }
    );
    expect([...(next.Products as Set<string>)].sort()).toEqual([
      'OIL',
      'SHAMPOO',
    ]);
  });

  it('agent hint that does not intersect distincts → falls back to all loaded (stale-hint guard)', () => {
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Region'],
      NO_PREV,
      undefined,
      null,
      { Region: ['East', 'West'] },
      { Region: ['SouthernHemisphere'] }
    );
    // Distincts are authoritative full set, so a hint that doesn't intersect
    // is treated as stale — fall back to all loaded values rather than
    // fabricate a selection containing values that don't exist.
    expect([...(next.Region as Set<string>)].sort()).toEqual(['East', 'West']);
  });

  it('falls back to row-derived distincts when the field is absent from datasetDistincts', () => {
    const next = syncFilterSelectionsWithFilters(
      [
        { Region: 'East', Sales: 100 },
        { Region: 'West', Sales: 50 },
      ],
      ['Region'],
      NO_PREV,
      undefined,
      null,
      // datasetDistincts intentionally omits Region
      {},
      null
    );
    expect([...(next.Region as Set<string>)].sort()).toEqual(['East', 'West']);
  });

  it('removes filter entries when their field is no longer in the FILTERS shelf', () => {
    const prev: FilterSelections = {
      Region: new Set(['East']),
      Channel: new Set(['Online']),
    };
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Region'],
      prev,
      undefined,
      null,
      { Region: ['East', 'West'] },
      null
    );
    expect(next.Region).toBeInstanceOf(Set);
    expect(next.Channel).toBeUndefined();
  });

  it('preserves an existing selection when the field stays in the shelf and distincts are unchanged', () => {
    const snap = { current: { Region: new Set(['East', 'West']) } };
    const prev: FilterSelections = { Region: new Set(['East']) };
    const next = syncFilterSelectionsWithFilters(
      [],
      ['Region'],
      prev,
      snap,
      null,
      { Region: ['East', 'West'] },
      null
    );
    expect([...(next.Region as Set<string>)]).toEqual(['East']);
  });

  describe('provenance — sample → authoritative upgrade preserves narrow hint', () => {
    it('two-call sequence (empty → full distincts) keeps the agent-narrowed selection', () => {
      const snap: FilterDistinctSnapshotRef = { current: {} };
      const prov: FilterDistinctProvenanceRef = { current: {} };
      const hint: Record<string, string[]> = {
        Products: ['FEMALE SHOWER GEL'],
      };

      // Call 1: sessionFilterDistincts has not loaded yet. The agent's
      // filtered preview rows only contain FEMALE SHOWER GEL, so the
      // sample-derived distinctNow is a single-value set.
      const afterFirst = syncFilterSelectionsWithFilters(
        [{ Products: 'FEMALE SHOWER GEL' }],
        ['Products'],
        {},
        snap,
        null,
        // datasetDistincts has not loaded for this field yet
        {},
        hint,
        prov
      );
      expect([...(afterFirst.Products as Set<string>)]).toEqual([
        'FEMALE SHOWER GEL',
      ]);
      expect(prov.current.Products).toBe('sample');
      expect([...snap.current.Products]).toEqual(['FEMALE SHOWER GEL']);

      // Call 2: full DuckDB distincts arrive. Without the upgrade guard, the
      // merge-new-distincts branch would silently broaden the selection to
      // the full universe (MARICO/PURITE/OLIV/LASHE all auto-added).
      const afterSecond = syncFilterSelectionsWithFilters(
        [{ Products: 'FEMALE SHOWER GEL' }],
        ['Products'],
        afterFirst,
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
        hint,
        prov
      );

      expect([...(afterSecond.Products as Set<string>)]).toEqual([
        'FEMALE SHOWER GEL',
      ]);
      expect(prov.current.Products).toBe('authoritative');
      expect([...snap.current.Products].sort()).toEqual([
        'FEMALE SHOWER GEL',
        'LASHE',
        'MARICO',
        'OLIV',
        'PURITE',
      ]);

      // Smoking-gun assertion: selection.size (1) !== snapshot.size (5),
      // so the payload builder DOES emit the field — server narrows to
      // FEMALE SHOWER GEL as the agent intended.
      expect(
        wouldOmitFromPayload(
          afterSecond.Products as Set<string>,
          snap.current.Products
        )
      ).toBe(false);
    });

    it('multi-value hint surviving the upgrade narrows to the intersection, not the full universe', () => {
      const snap: FilterDistinctSnapshotRef = { current: {} };
      const prov: FilterDistinctProvenanceRef = { current: {} };
      const hint: Record<string, string[]> = {
        Products: ['FEMALE SHOWER GEL', 'MARICO'],
      };

      const afterFirst = syncFilterSelectionsWithFilters(
        [
          { Products: 'FEMALE SHOWER GEL' },
          { Products: 'MARICO' },
        ],
        ['Products'],
        {},
        snap,
        null,
        {},
        hint,
        prov
      );
      expect([...(afterFirst.Products as Set<string>)].sort()).toEqual([
        'FEMALE SHOWER GEL',
        'MARICO',
      ]);

      const afterSecond = syncFilterSelectionsWithFilters(
        [
          { Products: 'FEMALE SHOWER GEL' },
          { Products: 'MARICO' },
        ],
        ['Products'],
        afterFirst,
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
        hint,
        prov
      );
      expect([...(afterSecond.Products as Set<string>)].sort()).toEqual([
        'FEMALE SHOWER GEL',
        'MARICO',
      ]);
      expect(
        wouldOmitFromPayload(
          afterSecond.Products as Set<string>,
          snap.current.Products
        )
      ).toBe(false);
    });

    it('intended merge-on-real-refresh still works (authoritative → authoritative)', () => {
      const snap: FilterDistinctSnapshotRef = { current: {} };
      const prov: FilterDistinctProvenanceRef = { current: {} };

      const afterFirst = syncFilterSelectionsWithFilters(
        [],
        ['Region'],
        {},
        snap,
        null,
        { Region: ['East', 'West'] },
        null,
        prov
      );
      expect([...(afterFirst.Region as Set<string>)].sort()).toEqual([
        'East',
        'West',
      ]);
      expect(prov.current.Region).toBe('authoritative');

      // Genuine data refresh: a new region (Central) appeared in the data.
      const afterSecond = syncFilterSelectionsWithFilters(
        [],
        ['Region'],
        afterFirst,
        snap,
        null,
        { Region: ['East', 'West', 'Central'] },
        null,
        prov
      );
      expect([...(afterSecond.Region as Set<string>)].sort()).toEqual([
        'Central',
        'East',
        'West',
      ]);
      expect(prov.current.Region).toBe('authoritative');
    });

    it('sample → sample (no-DuckDB preview variant) still merges new row values', () => {
      const snap: FilterDistinctSnapshotRef = { current: {} };
      const prov: FilterDistinctProvenanceRef = { current: {} };

      const afterFirst = syncFilterSelectionsWithFilters(
        [{ Region: 'East' }],
        ['Region'],
        {},
        snap,
        null,
        null,
        null,
        prov
      );
      expect([...(afterFirst.Region as Set<string>)]).toEqual(['East']);
      expect(prov.current.Region).toBe('sample');

      // More rows stream in (preview variant has no sessionId, so no
      // authoritative source).
      const afterSecond = syncFilterSelectionsWithFilters(
        [{ Region: 'East' }, { Region: 'West' }],
        ['Region'],
        afterFirst,
        snap,
        null,
        null,
        null,
        prov
      );
      expect([...(afterSecond.Region as Set<string>)].sort()).toEqual([
        'East',
        'West',
      ]);
      expect(prov.current.Region).toBe('sample');
    });

    it('removing a field from the shelf prunes both the snapshot and the provenance entries', () => {
      const snap: FilterDistinctSnapshotRef = {
        current: {
          Region: new Set(['East']),
          Channel: new Set(['Online']),
        },
      };
      const prov: FilterDistinctProvenanceRef = {
        current: { Region: 'authoritative', Channel: 'authoritative' },
      };
      const next = syncFilterSelectionsWithFilters(
        [],
        ['Region'],
        { Region: new Set(['East']), Channel: new Set(['Online']) },
        snap,
        null,
        { Region: ['East', 'West'] },
        null,
        prov
      );
      expect(next.Channel).toBeUndefined();
      expect(snap.current.Channel).toBeUndefined();
      expect(prov.current.Channel).toBeUndefined();
    });

    it('omitted provenance ref keeps backward-compatible 7-arg behavior', () => {
      // Existing callers that don't pass the 8th argument get the same
      // result the function gave before this fix.
      const snap: FilterDistinctSnapshotRef = {
        current: { Region: new Set(['East', 'West']) },
      };
      const next = syncFilterSelectionsWithFilters(
        [],
        ['Region'],
        { Region: new Set(['East']) },
        snap,
        null,
        { Region: ['East', 'West'] },
        null
      );
      expect([...(next.Region as Set<string>)]).toEqual(['East']);
    });
  });
});
