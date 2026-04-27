import type { SessionAnalysisContext } from "../../shared/schema.js";

/** Optional context so chart insights align with the user’s question and session understanding */
export type ChartInsightSynthesisContext = {
  userQuestion?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  permanentContext?: string;
  /**
   * W12 · composed FMCG/Marico domain context (already concatenated by
   * `loadEnabledDomainContext`). When present, chart insights add a
   * `businessCommentary` field framing the metric against industry priors.
   */
  domainContext?: string;
};
