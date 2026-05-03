import { describe, it, expect, beforeEach } from 'vitest';
import { withInflightLimit, __test__ } from './inflightLimiter';

/**
 * RL3-followup · client-side per-suffix concurrency limiter. Prevents the
 * arrival burst of N parallel chart-preview / chart-key-insight POSTs that
 * blew past server rate limits even with the per-session mutex in place.
 */

describe('withInflightLimit', () => {
  beforeEach(() => __test__.reset());

  it('allows up to N concurrent calls per suffix', async () => {
    const release: Array<() => void> = [];
    const make = () =>
      new Promise<string>((resolve) => {
        release.push(() => resolve('ok'));
      });

    const p1 = withInflightLimit('a', make, 2);
    const p2 = withInflightLimit('a', make, 2);
    // Yield to let acquisitions resolve
    await Promise.resolve();
    expect(__test__.state('a')?.inflight).toBe(2);
    expect(__test__.state('a')?.queued).toBe(0);

    const p3 = withInflightLimit('a', make, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(__test__.state('a')?.queued).toBe(1);

    release[0]!();
    await p1;
    // Yield so the waker for p3 fires
    await Promise.resolve();
    expect(__test__.state('a')?.queued).toBe(0);
    release[1]!();
    release[2]!();
    await Promise.all([p2, p3]);
    expect(__test__.state('a')?.inflight).toBe(0);
  });

  it('keeps suffixes independent', async () => {
    const release: Array<() => void> = [];
    const make = () =>
      new Promise<string>((resolve) => {
        release.push(() => resolve('ok'));
      });

    // Concurrency 1 per suffix; both should run in parallel since suffixes differ.
    const p1 = withInflightLimit('preview', make, 1);
    const p2 = withInflightLimit('insight', make, 1);
    await Promise.resolve();
    expect(__test__.state('preview')?.inflight).toBe(1);
    expect(__test__.state('insight')?.inflight).toBe(1);
    release[0]!();
    release[1]!();
    await Promise.all([p1, p2]);
  });

  it('releases the slot when the wrapped fn throws', async () => {
    await expect(
      withInflightLimit('a', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(__test__.state('a')?.inflight).toBe(0);
  });
});
