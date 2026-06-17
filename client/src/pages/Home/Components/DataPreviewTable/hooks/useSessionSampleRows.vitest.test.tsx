/**
 * ARCH-5 / CQ-3 / FE-2 · Behaviour pin for the `useSessionSampleRows` hook
 * extracted VERBATIM from DataPreviewTable.tsx. The hook owns the row-level
 * session-sample fetch used as the aggregated-only-preview fallback.
 *
 * Pins the contract the rest of the pivot web relies on:
 *  - Non-analysis variant OR no sessionId → no fetch; rows + error stay null.
 *  - Analysis + sessionId → fetches sample rows (limit 2000) and exposes them.
 *  - A failed fetch nulls the rows and surfaces the error message.
 *  - `clearSessionSampleError` clears the error marker (the reset-on-data-shape
 *    effect in the component calls this).
 *  - Switching from a live session back to a non-analysis/no-session state
 *    re-runs the effect and clears both slices.
 *
 * No Cosmos involvement — the only side effect is the mocked API client.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const fetchSessionSampleRows = vi.fn<
  (sessionId: string, limit?: number) => Promise<{
    sessionId: string;
    rows: Record<string, unknown>[];
    count: number;
    limit: number;
    random: boolean;
  }>
>();

vi.mock('@/lib/api', () => ({
  fetchSessionSampleRows: (sessionId: string, limit?: number) =>
    fetchSessionSampleRows(sessionId, limit),
}));

// Import AFTER the mock is registered.
import { useSessionSampleRows } from './useSessionSampleRows';

const makeResponse = (rows: Record<string, unknown>[]) => ({
  sessionId: 'sess-1',
  rows,
  count: rows.length,
  limit: 2000,
  random: false,
});

beforeEach(() => {
  fetchSessionSampleRows.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSessionSampleRows', () => {
  test('does not fetch and stays null for the dataset variant', async () => {
    const { result } = renderHook(() =>
      useSessionSampleRows({ variant: 'dataset', sessionId: 'sess-1' })
    );

    expect(fetchSessionSampleRows).not.toHaveBeenCalled();
    expect(result.current.sessionSampleRows).toBeNull();
    expect(result.current.sessionSampleError).toBeNull();
  });

  test('does not fetch when sessionId is absent', async () => {
    const { result } = renderHook(() =>
      useSessionSampleRows({ variant: 'analysis', sessionId: null })
    );

    expect(fetchSessionSampleRows).not.toHaveBeenCalled();
    expect(result.current.sessionSampleRows).toBeNull();
    expect(result.current.sessionSampleError).toBeNull();
  });

  test('fetches sample rows (limit 2000) and exposes them', async () => {
    const rows = [{ Region: 'North' }, { Region: 'South' }];
    fetchSessionSampleRows.mockResolvedValue(makeResponse(rows));

    const { result } = renderHook(() =>
      useSessionSampleRows({ variant: 'analysis', sessionId: 'sess-1' })
    );

    await waitFor(() => {
      expect(result.current.sessionSampleRows).toEqual(rows);
    });
    expect(result.current.sessionSampleError).toBeNull();
    expect(fetchSessionSampleRows).toHaveBeenCalledTimes(1);
    expect(fetchSessionSampleRows).toHaveBeenCalledWith('sess-1', 2000);
  });

  test('a failed fetch nulls rows and surfaces the error message', async () => {
    fetchSessionSampleRows.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() =>
      useSessionSampleRows({ variant: 'analysis', sessionId: 'sess-1' })
    );

    await waitFor(() => {
      expect(result.current.sessionSampleError).toBe('boom');
    });
    expect(result.current.sessionSampleRows).toBeNull();
  });

  test('clearSessionSampleError clears the error marker', async () => {
    fetchSessionSampleRows.mockRejectedValue(new Error('transient'));

    const { result } = renderHook(() =>
      useSessionSampleRows({ variant: 'analysis', sessionId: 'sess-1' })
    );

    await waitFor(() => {
      expect(result.current.sessionSampleError).toBe('transient');
    });

    act(() => {
      result.current.clearSessionSampleError();
    });

    expect(result.current.sessionSampleError).toBeNull();
  });

  test('switching back to non-analysis clears both rows and error', async () => {
    const rows = [{ Region: 'North' }];
    fetchSessionSampleRows.mockResolvedValue(makeResponse(rows));

    const { result, rerender } = renderHook(
      (props: { variant: 'dataset' | 'analysis'; sessionId: string | null }) =>
        useSessionSampleRows(props),
      { initialProps: { variant: 'analysis', sessionId: 'sess-1' } }
    );

    await waitFor(() => {
      expect(result.current.sessionSampleRows).toEqual(rows);
    });

    rerender({ variant: 'dataset', sessionId: 'sess-1' });

    await waitFor(() => {
      expect(result.current.sessionSampleRows).toBeNull();
    });
    expect(result.current.sessionSampleError).toBeNull();
  });
});
