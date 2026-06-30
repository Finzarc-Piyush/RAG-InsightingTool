/**
 * Decide whether App should "self-mint" the URL to `/analysis/:sessionId` in
 * response to Home reporting its current sessionId via `onSessionChange`.
 *
 * Self-mint exists for ONE event: Home just minted a brand-new session from an
 * upload (or Snowflake import) while the URL was bare (`/analysis`). It must
 * fire ONLY on a genuine NEW value — i.e. the reported sessionId differs from
 * the previously-reported one (null → real after a fresh upload) — never on a
 * STALE ECHO of a sessionId that was just stripped from the URL.
 *
 * That stale echo was the "New analysis" infinite-loader trap (L-040): a
 * re-render handed Home a fresh `onSessionChange` closure, the notify effect
 * replayed the OLD sessionId, and the guard (which only checked `sessionId`
 * truthy + `!urlSessionId`) self-minted the URL back to the session we had just
 * left — with no loaded snapshot — wedging Home on the spinner forever.
 *
 * `useNotifySessionChange` already stops the echo from firing at all (it gates
 * the notify on the VALUES, not the callback identity). This predicate is the
 * source-side belt-and-suspenders: even if some other re-render trigger echoes
 * a stale sessionId, `reported === prevReported` short-circuits the re-mint.
 *
 * There is no legitimate case where a self-mint is wanted with
 * `reported === prevReported`: after the first mint the URL is no longer bare,
 * so `urlSessionId` is set and this returns false anyway.
 */
export function shouldSelfMintSessionUrl(args: {
  /** sessionId Home just reported (its current internal sessionId). */
  reported: string | null;
  /** sessionId Home reported on the previous `onSessionChange` call. */
  prevReported: string | null;
  /** The session currently encoded in the URL (null when bare `/analysis`). */
  urlSessionId: string | null;
  /** The current wouter location. */
  location: string;
}): boolean {
  const { reported, prevReported, urlSessionId, location } = args;
  return (
    !!reported &&
    reported !== prevReported &&
    !urlSessionId &&
    location.startsWith('/analysis')
  );
}
