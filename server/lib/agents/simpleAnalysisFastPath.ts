/**
 * When AGENTIC_LOOP_ENABLED=true, route single-intent analysis questions to the
 * legacy AgentOrchestrator instead of the full planner/tool/critic loop — same
 * handler stack as non-agentic mode, faster for questions like sales trends.
 *
 * Disable with SIMPLE_ANALYSIS_FAST_PATH=false or 0.
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
