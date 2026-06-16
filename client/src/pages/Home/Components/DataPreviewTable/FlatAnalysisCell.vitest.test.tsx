import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { TemporalDisplayGrain, TemporalFacetColumnMeta } from '@/shared/schema';
import { formatAnalysisNumber } from '@/lib/formatAnalysisNumber';
import { formatDateCellForGrain } from '@/lib/temporalDisplayFormat';
import { formatTemporalFacetValue } from '@/lib/temporalFacetDisplay';
import {
  renderFlatAnalysisCell,
  type FlatAnalysisCellLookups,
} from './FlatAnalysisCell';

/**
 * Characterization tests pinning the EXACT cell-formatting precedence carved
 * out of DataPreviewTable.tsx's former inline `renderFlatAnalysisCell` closure
 * during the god-file decomposition. They lock the branch ordering (facet →
 * date → numeric → string) and null handling so the relocation stays
 * behaviour-preserving.
 */
function textOf(node: ReturnType<typeof renderFlatAnalysisCell>): string {
  const { container } = render(<>{node}</>);
  return container.textContent ?? '';
}

const empty: FlatAnalysisCellLookups = {
  facetMetaByName: {},
  effectiveDateColumns: [],
  resolvedGrainsByColumn: {},
  numericColumns: [],
};

describe('renderFlatAnalysisCell', () => {
  it('renders null/undefined as an italic "null"', () => {
    const node = renderFlatAnalysisCell('any', null, empty);
    const { container } = render(<>{node}</>);
    const span = container.querySelector('span');
    expect(span).not.toBeNull();
    expect(span?.className).toContain('italic');
    expect(span?.textContent).toBe('null');
    expect(textOf(renderFlatAnalysisCell('any', undefined, empty))).toBe('null');
  });

  it('formats a facet column via formatTemporalFacetValue (highest precedence)', () => {
    const facetGrain: TemporalFacetColumnMeta['grain'] = 'year';
    const facetMeta: TemporalFacetColumnMeta = {
      name: 'period',
      grain: facetGrain,
    } as TemporalFacetColumnMeta;
    const lookups: FlatAnalysisCellLookups = {
      ...empty,
      // Facet wins even when the column is also marked numeric/date.
      facetMetaByName: { period: facetMeta },
      effectiveDateColumns: ['period'],
      numericColumns: ['period'],
    };
    const raw = '2024';
    const expected = formatTemporalFacetValue(raw, facetGrain) ?? String(raw);
    expect(textOf(renderFlatAnalysisCell('period', raw, lookups))).toBe(expected);
  });

  it('formats a date column via formatDateCellForGrain when a grain is resolved', () => {
    const grain: TemporalDisplayGrain = 'monthOrQuarter';
    const lookups: FlatAnalysisCellLookups = {
      ...empty,
      effectiveDateColumns: ['order_date'],
      resolvedGrainsByColumn: { order_date: grain },
    };
    const raw = '2024-03-15';
    const expected = formatDateCellForGrain(raw, grain) ?? String(raw);
    expect(textOf(renderFlatAnalysisCell('order_date', raw, lookups))).toBe(expected);
  });

  it('falls back to String(raw) for a date column with no resolved grain', () => {
    const lookups: FlatAnalysisCellLookups = {
      ...empty,
      effectiveDateColumns: ['order_date'],
    };
    expect(textOf(renderFlatAnalysisCell('order_date', '2024-03-15', lookups))).toBe(
      '2024-03-15'
    );
  });

  it('formats a numeric column via formatAnalysisNumber', () => {
    const lookups: FlatAnalysisCellLookups = { ...empty, numericColumns: ['revenue'] };
    expect(textOf(renderFlatAnalysisCell('revenue', '1234.5', lookups))).toBe(
      formatAnalysisNumber(1234.5)
    );
  });

  it('falls back to String(raw) for a non-parseable numeric cell', () => {
    const lookups: FlatAnalysisCellLookups = { ...empty, numericColumns: ['revenue'] };
    expect(textOf(renderFlatAnalysisCell('revenue', 'n/a', lookups))).toBe('n/a');
  });

  it('renders a plain string for an unclassified column', () => {
    expect(textOf(renderFlatAnalysisCell('name', 'Acme', empty))).toBe('Acme');
  });
});
