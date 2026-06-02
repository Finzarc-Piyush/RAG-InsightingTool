/**
 * ============================================================================
 * index.ts — public entry point (barrel) for the agent runtime
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Re-exports the handful of functions and types that the rest of the server
 *   is allowed to use from server/lib/agents/runtime/. A file that only
 *   re-exports things from sibling modules is called a "barrel": it gives
 *   callers one tidy import path instead of reaching into deep file paths.
 *
 * WHY IT MATTERS
 *   Defines the runtime's public surface. Anything NOT listed here is an
 *   internal detail other code should not depend on, which keeps refactors safe.
 *
 * KEY PIECES
 *   - Re-exports the agent loop runner (runAgentTurn), config/flag helpers,
 *     context builders, inter-agent + working-memory formatters, and the Zod
 *     output schemas for planner/verifier/reflector.
 *
 * HOW IT CONNECTS
 *   Pulls from types.js, agentLoop.service.js, context.js, schemas.js,
 *   interAgentMessages.js, workingMemory.js, assertAgenticRag.js. Imported by
 *   the chat route / dataAnalyzer that drives a turn.
 */
export { assertAgenticRagConfiguration } from "./assertAgenticRag.js";
export {
  isAgenticLoopEnabled,
  isAgenticStrictEnabled,
  isInterAgentTraceEnabled,
  isInterAgentPromptFeedbackEnabled,
  loadAgentConfigFromEnv,
  AGENT_TRACE_MAX_BYTES,
  type AgentConfig,
  type AgentExecutionContext,
  type AgentMidTurnSessionPayload,
  type AgentLoopResult,
  type AgentTrace,
  type InterAgentMessage,
  type InterAgentRole,
  type StreamPreAnalysis,
  type WorkingMemoryEntry,
  type PlanStep,
} from "./types.js";
export {
  appendInterAgentMessage,
  formatInterAgentHandoffsForPrompt,
} from "./interAgentMessages.js";
export { formatWorkingMemoryBlock, sortPlanStepsByDependency } from "./workingMemory.js";
export {
  buildAgentExecutionContext,
  summarizeContextForPrompt,
  formatUserAndSessionJsonBlocks,
  appendixForReflectorPrompt,
} from "./context.js";
export { runAgentTurn, type AgentSseEmitter } from "./agentLoop.service.js";
export {
  plannerOutputSchema,
  verifierOutputSchema,
  reflectorOutputSchema,
  agentPlanEventSchema,
  agentCriticVerdictEventSchema,
} from "./schemas.js";
