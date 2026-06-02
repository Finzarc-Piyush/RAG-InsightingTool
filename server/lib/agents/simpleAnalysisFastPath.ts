/**
 * ============================================================================
 * simpleAnalysisFastPath.ts — a shortcut that sends easy questions down a
 * lighter, faster route instead of the full agent.
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The full agentic loop (planner → tools → critic) is powerful but slow and
 *   expensive — overkill for a plain "show me the sales trend" or "what's the
 *   revenue by month?". This file decides whether a question is simple enough to
 *   handle via the lighter AgentOrchestrator.processQuery path instead of the
 *   heavyweight runAgentTurn loop. It is pure decision logic: two lists of
 *   regexes — one that screams "too complex, use the real agent" (compare,
 *   correlate, train a model, dashboards, root cause…) and one that says "this
 *   is a simple chart/stat request" (trend, chart, over time, show me…).
 *
 * WHY IT MATTERS
 *   It's a latency/cost optimisation in early triage. It only ever applies to
 *   analysis-mode questions and errs on the side of caution: anything unclear
 *   falls through to the full agent, so the shortcut can never silently give a
 *   worse answer to a hard question. Controlled by the SIMPLE_ANALYSIS_FAST_PATH
 *   env var so it can be switched off entirely.
 *
 * KEY PIECES
 *   - isSimpleAnalysisFastPathEnabled() — reads SIMPLE_ANALYSIS_FAST_PATH;
 *     returns false only when explicitly set to 0/false/off, otherwise true.
 *   - shouldUseOrchestratorInsteadOfAgentLoop(question, mode) — returns true to
 *     take the fast path. Bails for non-analysis modes, bare confirmations
 *     ("yes"/"ok"), and anything matching the complex patterns; only returns
 *     true when a simple-analysis pattern matches.
 *
 * HOW IT CONNECTS
 *   Has no imports — just env reads and regex. Called by the chat request
 *   pipeline (chatStream.service / chat.service) after mode classification to
 *   choose between AgentOrchestrator.processQuery and the full runAgentTurn.
 */

export function isSimpleAnalysisFastPathEnabled(): boolean {
  const v = process.env.SIMPLE_ANALYSIS_FAST_PATH;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

/**
 * Returns true if the question should use AgentOrchestrator.processQuery instead of runAgentTurn.
 * Conservative: default to full agent when unsure.
 */
export function shouldUseOrchestratorInsteadOfAgentLoop(
  question: string,
  mode: "analysis" | "dataOps" | "modeling" | undefined
): boolean {
  if (!isSimpleAnalysisFastPathEnabled()) return false;
  if (mode && mode !== "analysis") return false;

  const q = question.trim();
  if (q.length < 4) return false;
  // Follow-ups without context — let agent/orchestrator downstream handle
  if (/^(yes|no|ok|sure|thanks|please|y|n)\.?$/i.test(q)) return false;

  // Complex / multi-step — full agent
  const complexPatterns: RegExp[] = [
    /\bcompare\b/i,
    /\bcorrelat/i,
    /\broot\s+cause/i,
    /dashboard/i,
    /\bpivot\b/i,
    /\badd\s+col/i,
    /\bremove\s+(col|row)/i,
    /\btrain\s+a?\s*model/i,
    /\bpredict\b/i,
    /\b(machine\s+learning|regression|classification)\b/i,
    /\bjoin\b.*\b(table|dataset)/i,
    /\bmerge\b.*\b(table|dataset)/i,
    /\bsegment\b/i,
    /\bdrill\s*down/i,
    /\bwhy\s+did\b/i,
    /\bexplain\s+why\b/i,
    /\bbuild\s+a?\s*(model|dashboard)/i,
    /\bcreate\s+a?\s*(pivot|dashboard)/i,
    /\bmultiple\s+(charts?|metrics?|series)/i,
    /\b(factors?\s+driving|drivers?\s+of|what\s+explains)\b/i,
    /\binvestigating\b.*\b(success|performance|factor|driver)s?\b/i,
  ];
  if (complexPatterns.some((p) => p.test(q))) return false;

  // Simple analysis / visualization phrasing
  const simplePatterns: RegExp[] = [
    /\btrend/i,
    /\bchart\b/i,
    /\bgraph\b/i,
    /\bplot\b/i,
    /\bvisuali[sz]e/i,
    /\bover\s+time/i,
    /\bover\s+(months?|weeks?|days?|years?|quarters?)/i,
    /\bby\s+(month|week|day|year|quarter|region|category)/i,
    /\b(show|what|how)\s+(is|are|was|were)\b/i,
    /\b(sales|revenue|profit|growth|performance)\s+(trend|over|by)/i,
    /\binsight/i,
    /\bpattern\b/i,
    /\bdistribution\b/i,
    /\b(show|give)\s+me\b/i,
    /\bbreakdown\b/i,
    /\b(bar|line|pie|area|scatter)\s*(chart)?\b/i,
  ];
  return simplePatterns.some((p) => p.test(q));
}
