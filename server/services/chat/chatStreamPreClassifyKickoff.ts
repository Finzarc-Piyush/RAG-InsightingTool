// Wave WS2-pre-classify-parallel · pure helper that fires the three pre-classify
// operations that have no data dependency on earlier results concurrently, so
// `processStreamChat` can `await` each at its existing consumption site while
// the others overlap on the LLM/disk hot path. SSE thinking-step emissions in
// the caller stay at their original line positions, so on-wire ordering is
// byte-identical to the pre-wave sequential code.
//
// Error semantics mirror the pre-wave inline behaviour:
//   - schemaBinding: no .catch — throws propagate on the caller's `await`
//   - parsedQuery:   .catch(() => null) — matches the pre-wave try/catch that
//                    set `parsedQueryForLoad = null` on parser failure
//   - domainContext: .catch(() => null) — matches the pre-wave try/catch that
//                    let the B4 classifier proceed without domain context
//
// Both catching kickoffs prevent unhandled-rejection warnings when
// `bindSchemaColumns` throws first and the other two settle later.
//
// Wave W-UD-integration · the kickoff now also runs the per-dataset directive
// hydration in parallel. `hydrateDirectives` is optional — when omitted the
// `activeDirectives` promise resolves to `[]` so callers can always pass the
// result into `buildAgentExecutionContext` without a null check. Failures are
// absorbed to `[]` for the same reason the other catching kickoffs swallow
// theirs: a directives-store outage must never block a chat turn.

import type { UserDirective } from "../../shared/schema.js";

export interface PreClassifyKickoffDeps<S, Q, D, M = unknown> {
  bindSchemaColumns: () => Promise<S>;
  parseUserQuery: () => Promise<Q>;
  loadDomainContext: () => Promise<D>;
  classifyMode?: (domainContext: D | null) => Promise<M>;
  /** Wave W-UD-integration · per-dataset directive hydration. Optional. */
  hydrateDirectives?: () => Promise<UserDirective[]>;
}

export interface PreClassifyKickoffResult<S, Q, D, M = unknown> {
  schemaBinding: Promise<S>;
  parsedQuery: Promise<Q | null>;
  domainContext: Promise<D | null>;
  modeClassification: Promise<M | null>;
  /** Wave W-UD-integration · active `UserDirective[]` for `(username, datasetFingerprint)`.
   *  Resolves to `[]` when no hydrator was supplied or the hydrator threw. */
  activeDirectives: Promise<UserDirective[]>;
}

export function kickOffPreClassifyWork<S, Q, D, M = unknown>(
  deps: PreClassifyKickoffDeps<S, Q, D, M>,
): PreClassifyKickoffResult<S, Q, D, M> {
  const schemaBinding = deps.bindSchemaColumns();
  const parsedQuery = deps.parseUserQuery().catch(() => null as Q | null);
  const domainContext = deps.loadDomainContext().catch(() => null as D | null);
  const modeClassification = deps.classifyMode
    ? domainContext.then((dc) => deps.classifyMode!(dc)).catch(() => null as M | null)
    : Promise.resolve(null as M | null);
  const activeDirectives = deps.hydrateDirectives
    ? deps.hydrateDirectives().catch(() => [] as UserDirective[])
    : Promise.resolve([] as UserDirective[]);
  return {
    schemaBinding,
    parsedQuery,
    domainContext,
    modeClassification,
    activeDirectives,
  };
}
