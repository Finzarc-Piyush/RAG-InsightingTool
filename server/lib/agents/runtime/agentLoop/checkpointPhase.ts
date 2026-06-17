/**
 * agentLoop/checkpointPhase.ts — the debounced mid-turn checkpoint glue,
 * extracted VERBATIM from the per-step loop of `runAgentTurn`
 * (findings ARCH-1 / CQ-1).
 *
 * WHAT IT DOES
 *   Wave A4 · After each reflector verdict, snapshot the running
 *   `agentInternals` to `chatDocument.currentTurnCheckpoint` so a mid-turn
 *   process crash leaves a partial answer the next session load can render.
 *   Best-effort, non-blocking, debounced (3s) inside `scheduleTurnCheckpoint`.
 *
 * WHY IT EXTRACTS CLEANLY
 *   This block has ZERO control-flow entanglement with the loop — no
 *   break/continue/return that the main loop depends on, just a guarded
 *   try/catch whose only effect is scheduling a best-effort write. It reads the
 *   working-memory + verdict + tool-I/O accumulators off `TurnState`, the
 *   step-count off `state.stepsWalked`, and `ctx` / `trace.startedAt`. The body
 *   below is byte-for-byte the inline version with `workingMemory` →
 *   `state.workingMemory`, etc.
 */
import type { AgentExecutionContext } from "../types.js";
import { scheduleTurnCheckpoint } from "../../../turnCheckpoint.js";
import { buildAgentInternals } from "../buildAgentInternals.js";
import type { TurnState } from "./turnState.js";

/**
 * Schedule the debounced mid-turn checkpoint from the current turn state.
 *
 * @param state    the per-turn accumulator bundle (read: workingMemory,
 *                 reflectorVerdicts, verifierVerdicts, toolIOEntries,
 *                 stepsWalked)
 * @param ctx      the agent execution context (sessionId / username / question /
 *                 blackboard)
 * @param startedAt the turn's `trace.startedAt` timestamp
 */
export function persistTurnCheckpoint(
  state: TurnState,
  ctx: AgentExecutionContext,
  startedAt: number
): void {
  if (ctx.sessionId && ctx.username) {
    try {
      scheduleTurnCheckpoint({
        sessionId: ctx.sessionId,
        username: ctx.username,
        question: ctx.question,
        agentInternals: buildAgentInternals({
          workingMemory: state.workingMemory,
          reflectorVerdicts: state.reflectorVerdicts,
          verifierVerdicts: state.verifierVerdicts,
          blackboard: ctx.blackboard,
          toolIO: state.toolIOEntries,
        }),
        stepsCompleted: state.stepsWalked,
        startedAt,
      });
    } catch {
      // Best-effort only.
    }
  }
}
