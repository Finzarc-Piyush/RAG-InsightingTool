/**
 * Agent System Entry Point — LEGACY LAYER
 * =======================================
 *
 * This file wires the LEGACY handler orchestrator. It is active only
 * when `AGENTIC_LOOP_ENABLED=false`. In production we ship with
 * `AGENTIC_LOOP_ENABLED=true`, which routes every chat turn through
 * the agentic runtime at `server/lib/agents/runtime/agentLoop.service.ts`
 * instead.
 *
 * DANGER — capability gap
 * -----------------------
 * The handlers registered below pre-date the Phase-1 skill catalog
 * (`variance_decomposer`, `driver_discovery`, `insight_explorer`,
 * `time_window_diff`) and Phase-2 dashboard autogen. Those features
 * live ONLY in the agentic runtime. Disabling
 * `AGENTIC_LOOP_ENABLED` as a hotfix therefore silently downgrades
 * the product — Phase-1 questions fall through to the generic
 * `GeneralHandler` and the user gets a shallow prose answer.
 *
 * If you need a hotfix knob:
 *   - `AGENT_TOOL_TIMEOUT_MS` — bound individual tool wall-time.
 *   - `AGENTIC_MAX_STEPS` — cap the plan length.
 *   - `DEEP_ANALYSIS_SKILLS_ENABLED=false` — turn off skills without
 *     leaving the agentic runtime.
 *
 * See:
 *   - docs/architecture/agent-runtime.md "Legacy layer" + "Known pitfalls"
 *   - docs/plans/agentic_only_rag_chat.md (no-legacy-fallback invariant)
 */

import { getOrchestrator } from './orchestrator.js';
import { ConversationalHandler } from './handlers/conversationalHandler.js';
import { StatisticalHandler } from './handlers/statisticalHandler.js';
import { ComparisonHandler } from './handlers/comparisonHandler.js';
import { CorrelationHandler } from './handlers/correlationHandler.js';
import { MLModelHandler } from './handlers/mlModelHandler.js';
import { DataOpsHandler } from './handlers/dataOpsHandler.js';
import { GeneralHandler } from './handlers/generalHandler.js';

/**
 * Initialize the agent system with all handlers
 */
export function initializeAgents() {
  const orchestrator = getOrchestrator();

  // Register handlers in priority order
  // More specific handlers should be registered first
  orchestrator.registerHandler(new ConversationalHandler());
  orchestrator.registerHandler(new DataOpsHandler()); // Data operations handler (for explicit mode and auto-detected dataOps)
  orchestrator.registerHandler(new MLModelHandler()); // ML model handler before other analysis handlers
  orchestrator.registerHandler(new StatisticalHandler()); // Statistical before correlation (for "which month" queries)
  orchestrator.registerHandler(new ComparisonHandler()); // Comparison before correlation (for "best competitor" queries)
  orchestrator.registerHandler(new CorrelationHandler());
  orchestrator.registerHandler(new GeneralHandler()); // General handler last (catch-all)

  console.log('✅ Agent system initialized with handlers');
  return orchestrator;
}

/**
 * Get initialized orchestrator
 */
let isInitialized = false;

export function getInitializedOrchestrator() {
  // Initialize if not already done
  if (!isInitialized) {
    initializeAgents();
    isInitialized = true;
  }
  return getOrchestrator();
}

export { getOrchestrator } from './orchestrator.js';
export { classifyIntent } from './intentClassifier.js';
export type { AnalysisIntent } from './intentClassifier.js';
export { resolveContextReferences } from './contextResolver.js';
export { retrieveContext } from './contextRetriever.js';

