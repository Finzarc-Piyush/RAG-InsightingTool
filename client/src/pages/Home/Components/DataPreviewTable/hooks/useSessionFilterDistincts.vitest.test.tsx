/**
 * ARCH-5 / CQ-3 / FE-2 · Behaviour pin for the `useSessionFilterDistincts`
 * hook extracted VERBATIM from DataPreviewTable.tsx. The hook owns the
 * authoritative per-field DuckDB distinct-value fetch for the FILTERS shelf.
 *
 * Pins the contract the rest of the pivot web relies on:
 *  - Non-analysis variant OR no sessionId OR no slice fields → no fetch, empty
 *    distincts, empty resolution.
 *  - Analysis + sessionId + fields → fetches each field, transitions the
 *    resolution from 'loading' to 'loaded', and exposes the distinct arrays.
 *  - A failing field surfaces as resolution 'error' (others still 'loaded').
 *  - Retry clears the error marker and re-fires the fetch (now succeeding).
 *  - Refetch fires only when the field SET changes, not on array-identity
 *    churn (the stable-signature dep contract).
 *
 * No Cosmos involvement — the only side effect is the mocked API client.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const fetchPivotColumnDistincts = vi.fn<
  (sessionId: string, column: string) => Promise<string[]>
>();

vi.mock('@/lib/api', () => ({
  fetchPivotColumnDistincts: (sessionId: string, column: string) =>
    fetchPivotColumnDistincts(sessionId, column),
}));

// Import AFTER the mock is registered.
import { useSessionFilterDistincts } from './useSessionFilterDistincts';

beforeEach(() => {
  fetchPivotColumnDistincts.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSessionFilterDistincts', () => {
  test('does not fetch and stays empty for the dataset variant', async () => {
    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'dataset',
        sessionId: 'sess-1',
        pivotSyncFields: ['Region'],
        pivotDistinctFieldsSignature: 'Region',
      })
    );

    expect(fetchPivotColumnDistincts).not.toHaveBeenCalled();
    expect(result.current.sessionFilterDistincts).toEqual({});
    // Resolution is derived from pivotSyncFields membership: 'loading' until a
    // fetch completes — but no fetch fires in the dataset variant.
    expect(result.current.filterDistinctsResolution).toEqual({
      Region: 'loading',
    });
  });

  test('does not fetch when sessionId is absent', async () => {
    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'analysis',
        sessionId: null,
        pivotSyncFields: ['Region'],
        pivotDistinctFieldsSignature: 'Region',
      })
    );

    expect(fetchPivotColumnDistincts).not.toHaveBeenCalled();
    expect(result.current.sessionFilterDistincts).toEqual({});
  });

  test('does not fetch when there are no slice fields', async () => {
    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'analysis',
        sessionId: 'sess-1',
        pivotSyncFields: [],
        pivotDistinctFieldsSignature: '',
      })
    );

    expect(fetchPivotColumnDistincts).not.toHaveBeenCalled();
    expect(result.current.sessionFilterDistincts).toEqual({});
    expect(result.current.filterDistinctsResolution).toEqual({});
  });

  test('fetches each field and transitions resolution loading → loaded', async () => {
    fetchPivotColumnDistincts.mockImplementation(async (_sid, col) =>
      col === 'Region' ? ['North', 'South'] : ['2024', '2025']
    );

    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'analysis',
        sessionId: 'sess-1',
        pivotSyncFields: ['Region', 'Year'],
        pivotDistinctFieldsSignature: 'Region\0Year',
      })
    );

    // Synchronously derived before the fetch resolves: both 'loading'.
    expect(result.current.filterDistinctsResolution).toEqual({
      Region: 'loading',
      Year: 'loading',
    });

    await waitFor(() => {
      expect(result.current.filterDistinctsResolution).toEqual({
        Region: 'loaded',
        Year: 'loaded',
      });
    });

    expect(result.current.sessionFilterDistincts).toEqual({
      Region: ['North', 'South'],
      Year: ['2024', '2025'],
    });
    expect(fetchPivotColumnDistincts).toHaveBeenCalledTimes(2);
    expect(fetchPivotColumnDistincts).toHaveBeenCalledWith('sess-1', 'Region');
    expect(fetchPivotColumnDistincts).toHaveBeenCalledWith('sess-1', 'Year');
  });

  test('a failing field resolves to error; healthy fields still load', async () => {
    fetchPivotColumnDistincts.mockImplementation(async (_sid, col) => {
      if (col === 'Year') throw new Error('boom');
      return ['North', 'South'];
    });

    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'analysis',
        sessionId: 'sess-1',
        pivotSyncFields: ['Region', 'Year'],
        pivotDistinctFieldsSignature: 'Region\0Year',
      })
    );

    await waitFor(() => {
      expect(result.current.filterDistinctsResolution.Year).toBe('error');
    });
    expect(result.current.filterDistinctsResolution.Region).toBe('loaded');
    expect(result.current.sessionFilterDistincts.Region).toEqual([
      'North',
      'South',
    ]);
  });

  test('retry clears the error marker and re-fetches', async () => {
    let failYear = true;
    fetchPivotColumnDistincts.mockImplementation(async (_sid, col) => {
      if (col === 'Year' && failYear) throw new Error('transient');
      return col === 'Year' ? ['2024'] : ['North'];
    });

    const { result } = renderHook(() =>
      useSessionFilterDistincts({
        variant: 'analysis',
        sessionId: 'sess-1',
        pivotSyncFields: ['Region', 'Year'],
        pivotDistinctFieldsSignature: 'Region\0Year',
      })
    );

    await waitFor(() => {
      expect(result.current.filterDistinctsResolution.Year).toBe('error');
    });

    failYear = false;
    act(() => {
      result.current.handleRetryFilterDistincts('Year');
    });

    await waitFor(() => {
      expect(result.current.filterDistinctsResolution.Year).toBe('loaded');
    });
    expect(result.current.sessionFilterDistincts.Year).toEqual(['2024']);
  });

  test('does not refetch on array-identity churn when the signature is unchanged', async () => {
    fetchPivotColumnDistincts.mockResolvedValue(['North']);

    const { result, rerender } = renderHook(
      (props: { fields: string[] }) =>
        useSessionFilterDistincts({
          variant: 'analysis',
          sessionId: 'sess-1',
          pivotSyncFields: props.fields,
          pivotDistinctFieldsSignature: props.fields.join('\0'),
        }),
      { initialProps: { fields: ['Region'] } }
    );

    await waitFor(() => {
      expect(result.current.filterDistinctsResolution.Region).toBe('loaded');
    });
    expect(fetchPivotColumnDistincts).toHaveBeenCalledTimes(1);

    // New array identity, same signature → effect must NOT re-fire.
    rerender({ fields: ['Region'] });
    await Promise.resolve();
    expect(fetchPivotColumnDistincts).toHaveBeenCalledTimes(1);
  });
});
