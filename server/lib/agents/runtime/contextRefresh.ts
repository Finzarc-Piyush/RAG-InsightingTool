/**
 * Wave B8 · step-triggered RAG / domain pack refresh.
 *
 * Tools that emit a finding which references a new domain term or that opens
 * a question only answerable by additional retrieval can call
 * `runtime.requestRagRound(query)` or `runtime.requestDomainPack(packId)` to
 * trigger a Round-2 fetch. Throttled (max 3 RAG, 2 domain per turn) and
 * de-duped on (query, packId) so chatty tools can't blow the budget.
 *
 * Hits are added to `state.ragHits` with `triggeredByStepId` so the planner /
 * narrator can attribute them. Failures are non-fatal.
 */

const RAG_BUDGET_PER_TURN = 3;
const DOMAIN_BUDGET_PER_TURN = 2;

interface TurnRefreshState {
  ragQueriesUsed: Set<string>;
  domainPacksUsed: Set<string>;
  ragCount: number;
  domainCount: number;
}

const state = new Map<string, TurnRefreshState>();

function get(turnId: string): TurnRefreshState {
  let s = state.get(turnId);
  if (!s) {
    s = {
      ragQueriesUsed: new Set(),
      domainPacksUsed: new Set(),
      ragCount: 0,
      domainCount: 0,
    };
    state.set(turnId, s);
  }
  return s;
}

export function canRequestRag(turnId: string, query: string): boolean {
  const s = get(turnId);
  const key = query.trim().slice(0, 200).toLowerCase();
  if (s.ragQueriesUsed.has(key)) return false; // already fetched this query
  return s.ragCount < RAG_BUDGET_PER_TURN;
}

export function recordRagRound(turnId: string, query: string): void {
  const s = get(turnId);
  s.ragQueriesUsed.add(query.trim().slice(0, 200).toLowerCase());
  s.ragCount++;
}

export function canRequestDomainPack(turnId: string, packId: string): boolean {
  const s = get(turnId);
  if (s.domainPacksUsed.has(packId)) return false;
  return s.domainCount < DOMAIN_BUDGET_PER_TURN;
}

export function recordDomainPackFetch(turnId: string, packId: string): void {
  const s = get(turnId);
  s.domainPacksUsed.add(packId);
  s.domainCount++;
}

/** Clean up at turn end. */
export function clearTurnRefreshBudget(turnId: string): void {
  state.delete(turnId);
}

/** Test/observability hook. */
export function getRefreshState(turnId: string) {
  return state.get(turnId);
}
