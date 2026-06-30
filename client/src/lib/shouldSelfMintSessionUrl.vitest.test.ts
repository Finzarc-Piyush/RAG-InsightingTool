// shouldSelfMintSessionUrl — the source-side guard for the "New analysis"
// infinite-loader trap (L-040). Self-mint must fire on a genuine new mint
// (null → real, URL bare) and NEVER on a stale echo of a just-stripped session.
import { describe, it, expect } from 'vitest';
import { shouldSelfMintSessionUrl } from './shouldSelfMintSessionUrl';

describe('shouldSelfMintSessionUrl', () => {
  it('self-mints on a genuine null → real upload mint while the URL is bare', () => {
    expect(
      shouldSelfMintSessionUrl({
        reported: 'NEW',
        prevReported: null,
        urlSessionId: null,
        location: '/analysis',
      }),
    ).toBe(true);
  });

  it('self-mints when a fresh Home (post-remount) mints a different session', () => {
    // After "New analysis", Home remounts and reports null first, then mints NEW2.
    expect(
      shouldSelfMintSessionUrl({
        reported: 'NEW2',
        prevReported: null,
        urlSessionId: null,
        location: '/analysis',
      }),
    ).toBe(true);
  });

  // THE TRAP: Home echoes the SAME sessionId it was already on while the URL is
  // bare — this is the stale replay that wedged the spinner. Must NOT re-mint.
  it('does NOT self-mint a stale echo of the same sessionId', () => {
    expect(
      shouldSelfMintSessionUrl({
        reported: 'SID',
        prevReported: 'SID',
        urlSessionId: null,
        location: '/analysis',
      }),
    ).toBe(false);
  });

  it('does NOT self-mint when the URL already encodes a session', () => {
    expect(
      shouldSelfMintSessionUrl({
        reported: 'NEW',
        prevReported: null,
        urlSessionId: 'NEW',
        location: '/analysis/NEW',
      }),
    ).toBe(false);
  });

  it('does NOT self-mint a null report (a reset / fresh-mount tick)', () => {
    expect(
      shouldSelfMintSessionUrl({
        reported: null,
        prevReported: 'SID',
        urlSessionId: null,
        location: '/analysis',
      }),
    ).toBe(false);
  });

  it('does NOT self-mint when navigated away from the analysis surface', () => {
    expect(
      shouldSelfMintSessionUrl({
        reported: 'NEW',
        prevReported: null,
        urlSessionId: null,
        location: '/dashboard',
      }),
    ).toBe(false);
  });
});
