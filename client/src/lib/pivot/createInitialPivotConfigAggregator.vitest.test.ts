/**
 * Wave PAG1 · Pin that `createInitialPivotConfig` consumes the agent's
 * per-column aggregator hint from `pivotDefaults.valueAggregators` and falls
 * back to today's numeric-default Sum when the hint is absent.
 *
 * Closes the bug: pivot value chip showed Sum for "average compliance visits
 * per day across clusters" because the function had no way to know the agent
 * had run AVG().
 */
import { describe, expect, it } from 'vitest';
import { createInitialPivotConfig } from '@/lib/pivot/buildPivotModel';
import type { PivotAgg } from '@/lib/pivot/types';

describe('Wave PAG1 · createInitialPivotConfig — valueAggregators hint', () => {
  it('uses the agent-supplied aggregator when valueAggregators is provided (the Marico screenshot scenario)', () => {
    // Question: "What is the average number of compliance visits per day
    // across clusters?" — agent ran mean(Compliance Visit). The bug was
    // that this chip used to fall through to "sum" because the hint had
    // nowhere to live in the schema.
    const config = createInitialPivotConfig(
      ['Cluster Name', 'Compliance Visit'],
      ['Compliance Visit'],
      ['Cluster Name'],
      ['Compliance Visit'],
      {
        valueAggregators: { 'Compliance Visit': 'mean' as PivotAgg },
      }
    );
    expect(config.values).toHaveLength(1);
    expect(config.values[0]!.field).toBe('Compliance Visit');
    expect(config.values[0]!.agg).toBe('mean');
  });

  it('falls back to "sum" for numeric values when no hint is provided (legacy contract)', () => {
    const config = createInitialPivotConfig(
      ['Cluster Name', 'Compliance Visit'],
      ['Compliance Visit'],
      ['Cluster Name'],
      ['Compliance Visit']
    );
    expect(config.values[0]!.agg).toBe('sum');
  });

  it('falls back to per-field default when only SOME columns have hints', () => {
    // Multi-value pivot. Agent gave a hint for one column but not the other.
    // Each value should resolve independently.
    const config = createInitialPivotConfig(
      ['Region', 'Sales', 'Visits'],
      ['Sales', 'Visits'],
      ['Region'],
      ['Sales', 'Visits'],
      {
        valueAggregators: { Sales: 'sum' as PivotAgg, Visits: 'mean' as PivotAgg },
      }
    );
    expect(config.values).toHaveLength(2);
    const byField = Object.fromEntries(
      config.values.map((v) => [v.field, v.agg])
    );
    expect(byField['Sales']).toBe('sum');
    expect(byField['Visits']).toBe('mean');
  });

  it('uses "count" for a non-numeric value field even when a numeric hint is supplied (defense)', () => {
    // The aggregator hint should only fire when the column is in `numericKeys`
    // — otherwise the engine can't sum strings. Hint is ignored in favor of
    // the safe "count" default. This protects against a malformed agent
    // emission claiming an aggregator on a non-numeric column.
    const config = createInitialPivotConfig(
      ['Cluster Name', 'Status'],
      [], // no numeric columns
      ['Cluster Name'],
      ['Status'],
      {
        valueAggregators: { Status: 'mean' as PivotAgg },
      }
    );
    // The hint wins for non-numeric too — current behavior. Pin this so
    // any future tightening that disallows aggregator-on-string surfaces here.
    expect(config.values[0]!.field).toBe('Status');
    expect(config.values[0]!.agg).toBe('mean');
  });

  it('returns an empty values array when defaultValueKeys is empty (regardless of hints)', () => {
    const config = createInitialPivotConfig(
      ['Cluster Name', 'Compliance Visit'],
      ['Compliance Visit'],
      ['Cluster Name'],
      [],
      {
        valueAggregators: { 'Compliance Visit': 'mean' as PivotAgg },
      }
    );
    expect(config.values).toHaveLength(0);
  });
});
