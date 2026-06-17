/**
 * agentLoop/emit.ts — SSE emit + client-abort helper FACTORIES for the agent
 * loop.
 *
 * Wave (ARCH-1/CQ-1) · These two helpers were inline closures inside
 * `runAgentTurn`. They are the only pieces of the per-turn machinery with ZERO
 * mutable shared state — `makeSafeEmit` closes over nothing but the optional
 * `emit` callback, and `makeCheckAbort` closes over nothing but `ctx.abortSignal`
 * + `turnId` (both read-only). Extracting them as explicit factories (no hidden
 * closure threading) shrinks the god-file by a self-contained slice while keeping
 * behaviour byte-identical: the returned closures have the same bodies as the
 * inline versions.
 *
 * NOT extracted here: `onLlmCall` — it owns the mutable per-turn LLM-budget
 * counter that is ALSO read at the final return (telemetry), so pulling it out
 * would require threading the count back through a getter. That is exactly the
 * shared-state coupling this wave avoids; it stays inline in `runAgentTurn`.
 */
import { agentLog } from "../agentLogger.js";

/** SSE emitter signature: `(eventName, dataPayload) => void`. */
export type AgentSseEmitter = (event: string, data: unknown) => void;

/**
 * Build the per-turn `safeEmit`: forwards to the (optional) client `emit`
 * callback, swallowing any client-side throw so a dropped SSE connection never
 * crashes the turn. Identical body to the former inline closure.
 */
export function makeSafeEmit(
  emit: AgentSseEmitter | undefined
): (event: string, data: unknown) => void {
  return (event: string, data: unknown) => {
    try {
      emit?.(event, data);
    } catch {
      /* ignore client errors */
    }
  };
}

/**
 * F3 · Build the per-turn `checkAbort`: throws `AGENT_CLIENT_ABORTED` when the
 * SSE stream's owner has hung up (the caller maps this to a clean early-return).
 * Probed at major step boundaries (planner, tool dispatch, synthesis, visual
 * planner) so we don't burn LLM budget for a tab the user closed. Identical body
 * to the former inline closure.
 */
export function makeCheckAbort(
  ctx: { abortSignal?: { aborted: boolean } },
  turnId: string
): (label: string) => void {
  return (label: string): void => {
    if (ctx.abortSignal?.aborted) {
      agentLog("agent.client_aborted", { turnId, label });
      throw new Error("AGENT_CLIENT_ABORTED");
    }
  };
}
