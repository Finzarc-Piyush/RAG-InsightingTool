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

export interface PreClassifyKickoffDeps<S, Q, D> {
  bindSchemaColumns: () => Promise<S>;
  parseUserQuery: () => Promise<Q>;
  loadDomainContext: () => Promise<D>;
}

export interface PreClassifyKickoffResult<S, Q, D> {
  schemaBinding: Promise<S>;
  parsedQuery: Promise<Q | null>;
  domainContext: Promise<D | null>;
}

export function kickOffPreClassifyWork<S, Q, D>(
  deps: PreClassifyKickoffDeps<S, Q, D>,
): PreClassifyKickoffResult<S, Q, D> {
  return {
    schemaBinding: deps.bindSchemaColumns(),
    parsedQuery: deps.parseUserQuery().catch(() => null),
    domainContext: deps.loadDomainContext().catch(() => null),
  };
}
