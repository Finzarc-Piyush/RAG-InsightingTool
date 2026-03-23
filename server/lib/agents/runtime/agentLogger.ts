/**
 * Structured agent logs — no PII; safe for aggregation.
 */
export function agentLog(event: string, fields: Record<string, string | number | boolean | undefined>) {
  const payload = { ts: Date.now(), event: `agent.${event}`, ...fields };
  console.log(JSON.stringify(payload));
}
