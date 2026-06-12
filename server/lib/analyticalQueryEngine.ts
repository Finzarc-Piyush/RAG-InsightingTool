/**
 * Analytical Query Engine — query classifiers
 *
 * Lightweight, dependency-free heuristics that classify a user question as
 * information-seeking or analytical. Used for routing decisions in the chat
 * pipeline. (The legacy LLM-driven execution-plan path was removed; the
 * agentic loop owns query execution now.)
 */

/**
 * Detects if a question is an information-seeking query (extracting specific data from CSV/Excel)
 * These queries should use the query-only reasoning layer (return only query/plan, no explanations)
 */
export function isInformationSeekingQuery(question: string): boolean {
  const lowerQuestion = question.toLowerCase();

  // Exclude visualization/analysis keywords - these should use current architecture
  // Also exclude explicit data operation keywords - these should go through DataOpsHandler
  const excludeKeywords = [
    'chart', 'graph', 'plot', 'visualize', 'visualization', 'diagram',
    'bar chart', 'line chart', 'pie chart', 'scatter plot', 'histogram',
    'show me a', 'create a chart', 'draw a', 'plot a', 'graph of',
    'correlation', 'correlate', 'impact', 'affect', 'influence', 'relationship',
    'analyze', 'analysis', 'trend', 'pattern', 'insight', 'statistic',
    // Explicit data operation keywords - these should create/modify tables
    'aggregate', 'aggregation', 'group by', 'grouped by', 'create a table', 'create table',
    'create new table', 'new table', 'pivot table', 'pivot', 'modify table', 'change table',
    'transform table', 'restructure', 'reorganize', 'save as', 'export as'
  ];

  // If it contains exclusion keywords, it's NOT an information-seeking query
  if (excludeKeywords.some(keyword => lowerQuestion.includes(keyword))) {
    return false;
  }

  // Information-seeking patterns - queries that extract specific data
  // These typically ask "which/what/how many" entities meet certain criteria
  const informationSeekingPatterns = [
    // "Which X..." - asking for specific entities (e.g., "Which regions generated...")
    /\bwhich\s+\w+(\s+\w+)*\s+(generated|made|sold|earned|had|exceeded|crossed|reached|achieved|have|has)/i,
    /\bwhich\s+\w+(\s+\w+)*\s+(more than|less than|above|below|exceeding|between)/i,

    // "What X..." - asking for specific values/entities
    /\bwhat\s+\w+(\s+\w+)*\s+(generated|made|sold|earned|had|exceeded|crossed|reached|achieved|have|has)/i,
    /\bwhat\s+\w+(\s+\w+)*\s+(more than|less than|above|below|exceeding|between)/i,

    // "How many X..." - counting entities
    /\bhow many\s+\w+(\s+\w+)*/i,

    // "How much X..." - asking for amounts
    /\bhow much\s+\w+(\s+\w+)*/i,

    // "Find X..." - searching for specific entities
    /\bfind\s+\w+(\s+\w+)*\s+(that|which|where)/i,

    // "List X..." - listing entities
    /\blist\s+\w+(\s+\w+)*\s+(that|which|where)/i,

    // "Show me X..." (but NOT "show me a chart")
    /\bshow me\s+\w+(\s+\w+)*\s+(that|which|where|with|having)/i,

    // "Give me X..." (but NOT "give me a chart")
    /\bgive me\s+\w+(\s+\w+)*\s+(that|which|where|with|having)/i,

    // Queries with filters/conditions asking for specific results
    // (e.g., "Regions that generated more than...")
    /\b\w+(\s+\w+)*\s+(generated|made|sold|earned|had|exceeded|crossed|reached|achieved|have|has)\s+(more than|less than|above|below|exceeding)/i,
  ];

  return informationSeekingPatterns.some(pattern => pattern.test(question));
}

/**
 * Detects if a question is analytical (not visualization)
 * @deprecated Use isInformationSeekingQuery() for query-only layer routing
 */
export function isAnalyticalQuery(question: string): boolean {
  const lowerQuestion = question.toLowerCase();

  // Visualization keywords
  const visualizationKeywords = [
    'chart', 'graph', 'plot', 'visualize', 'visualization', 'diagram',
    'bar chart', 'line chart', 'pie chart', 'scatter plot', 'histogram',
    'show me a', 'create a chart', 'draw a', 'plot a', 'graph of'
  ];

  // Check if it's a visualization request
  const isVisualization = visualizationKeywords.some(keyword => lowerQuestion.includes(keyword));

  if (isVisualization) {
    return false;
  }

  // Analytical question patterns
  const analyticalPatterns = [
    /\b(what|which|how many|how much|show me|give me|tell me|find|calculate|compute|count|sum|total|average|mean)\b/i,
    /\b(more than|less than|above|below|exceeding|between|during|in|from|to)\b/i,
    /\b(for|where|with|having|that|specific)\b/i,
  ];

  return analyticalPatterns.some(pattern => pattern.test(lowerQuestion));
}
