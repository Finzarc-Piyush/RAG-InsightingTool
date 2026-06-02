/**
 * ============================================================================
 * contextRefresh.ts — per-turn budget for extra mid-turn retrieval
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Mid-turn, a tool may discover it needs more reference material — another
 *   RAG search (RAG = the dataset/document search index) or a "domain pack" (a
 *   bundle of business-domain context). This module is the bookkeeper that
 *   caps and de-dupes those extra fetches per turn: at most 3 RAG searches and
 *   2 domain packs, and never the same query/pack twice.
 *
 * WHY IT MATTERS
 *   Without a budget, a chatty tool could fire endless retrievals and blow up
 *   latency and cost. This keeps "fetch more context on demand" useful but bounded.
 *
 * KEY PIECES
 *   - canRequestRag / recordRagRound — check-then-record a RAG fetch for a turn.
 *   - canRequestDomainPack / recordDomainPackFetch — same for domain packs.
 *   - clearTurnRefreshBudget(turnId) — free the per-turn state at turn end.
 *   - getRefreshState(turnId) — peek at counters (tests / observability).
 *
 * HOW IT CONNECTS
 *   Called by the act loop's requestRagRound / requestDomainPack handlers; the
 *   resulting hits are attributed back to the triggering step for the planner /
 *   narrator. State is an in-memory Map keyed by turnId.
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
