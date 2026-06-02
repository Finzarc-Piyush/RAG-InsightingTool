/**
 * ============================================================================
 * agentLogger.ts — one-line JSON logger for the agent engine
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Prints a single structured JSON line to the console for one agent event.
 *   "Structured" means the log is machine-readable JSON (not free text), so
 *   a log aggregator can group and search events. It stamps the current time
 *   and namespaces every event under "agent." (e.g. "agent.planner_done").
 *
 * WHY IT MATTERS
 *   Gives the agentic loop a consistent, no-PII (no personal info) way to emit
 *   telemetry. Consistent shape is what makes dashboards/alerts possible.
 *
 * KEY PIECES
 *   - agentLog(event, fields) — emit one JSON line: { ts, event, ...fields }.
 *
 * HOW IT CONNECTS
 *   Called throughout server/lib/agents/runtime/ wherever a step wants to
 *   record what happened. Pure console.log — no external sink.
 */
export function agentLog(event: string, fields: Record<string, string | number | boolean | undefined>) {
  const payload = { ts: Date.now(), event: `agent.${event}`, ...fields };
  console.log(JSON.stringify(payload));
}
