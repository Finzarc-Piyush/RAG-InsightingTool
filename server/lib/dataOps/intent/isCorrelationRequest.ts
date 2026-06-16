/**
 * `isCorrelationRequest` intent helper — extracted verbatim from
 * `dataOpsOrchestrator.ts` (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure predicate over the raw user message, zero coupling to the orchestrator's
 * locals / session state. Returns true when the message is clearly asking for
 * correlation analysis (relationship between variables), which must be routed to
 * Analysis rather than treated as a Data-Ops aggregate. Behaviour-preserving move.
 */

/**
 * Returns true if the message is clearly asking for correlation analysis (not aggregation).
 * Correlation = relationship between variables; must be handled by Analysis, not Data Ops.
 */
export function isCorrelationRequest(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return (
    /\bcorrelation\s+(of|between|with|for)\b/i.test(lower) ||
    /\bcorrelate\s+/i.test(lower) ||
    /\b(what\s+)(affects?|impacts?|influences?)\s+/i.test(lower) ||
    /\brelationship\s+(between|of)\s+/i.test(lower)
  );
}
