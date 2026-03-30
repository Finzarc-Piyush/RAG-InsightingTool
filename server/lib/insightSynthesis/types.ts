import type { SessionAnalysisContext } from "../../shared/schema.js";

/** Optional context so chart insights align with the user’s question and session understanding */
export type ChartInsightSynthesisContext = {
  userQuestion?: string;
  sessionAnalysisContext?: SessionAnalysisContext;
  permanentContext?: string;
};
