// useNotifySessionChange — the notify contract that fixes the "New analysis"
// infinite-loading hang (L-040).
//
// The bug: App's `onSessionChange` (handleSessionChange) is an unmemoized
// closure, so it changes identity on every Router render. Clicking "New
// analysis" re-renders App while Home's internal sessionId is still the OLD
// session; an identity-gated notify effect would then replay that STALE
// sessionId back to App and self-mint the URL, trapping Home in an
// unrecoverable loader. This hook must fire on VALUE changes only.
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNotifySessionChange } from './useNotifySessionChange';

describe('useNotifySessionChange', () => {
  it('fires once on mount with the initial sessionId/fileName', () => {
    const cb = vi.fn();
    renderHook(() => useNotifySessionChange('SID', 'data.xlsx', cb));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith('SID', 'data.xlsx');
  });

  it('fires again when sessionId changes', () => {
    const cb = vi.fn();
    const { rerender } = renderHook(
      ({ id }) => useNotifySessionChange(id, 'data.xlsx', cb),
      { initialProps: { id: null as string | null } },
    );
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(null, 'data.xlsx');

    rerender({ id: 'SID' });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('SID', 'data.xlsx');
  });

  it('fires again when fileName changes', () => {
    const cb = vi.fn();
    const { rerender } = renderHook(
      ({ name }) => useNotifySessionChange('SID', name, cb),
      { initialProps: { name: 'a.xlsx' } },
    );
    expect(cb).toHaveBeenCalledTimes(1);

    rerender({ name: 'b.xlsx' });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith('SID', 'b.xlsx');
  });

  // THE REGRESSION GUARD: a parent re-render that only churns the callback
  // identity (sessionId/fileName unchanged) must NOT replay the stale values.
  it('does NOT fire when only the callback identity changes', () => {
    const first = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useNotifySessionChange('SID', 'data.xlsx', cb),
      { initialProps: { cb: first } },
    );
    expect(first).toHaveBeenCalledTimes(1);

    // App re-renders → brand-new closure, but the session values are identical.
    const second = vi.fn();
    rerender({ cb: second });
    rerender({ cb: vi.fn() });

    expect(first).toHaveBeenCalledTimes(1); // still just the mount call
    expect(second).not.toHaveBeenCalled(); // the churn must be a no-op
  });

  // When a genuine value change DOES fire after a churn, it must invoke the
  // freshest callback (so it reads the parent's current urlSessionId/location).
  it('invokes the latest callback when a value change fires after a churn', () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    const { rerender } = renderHook(
      ({ id, cb }) => useNotifySessionChange(id, 'data.xlsx', cb),
      { initialProps: { id: null as string | null, cb: stale } },
    );
    // Parent swaps the callback without changing the session value.
    rerender({ id: null, cb: fresh });
    expect(fresh).not.toHaveBeenCalled();

    // Now an upload mints a real sessionId.
    rerender({ id: 'SID', cb: fresh });
    expect(stale).toHaveBeenCalledTimes(1); // only its own mount call
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(fresh).toHaveBeenLastCalledWith('SID', 'data.xlsx');
  });
});
