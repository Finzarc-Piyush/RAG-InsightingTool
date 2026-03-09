import type { MetricFormulaMetric } from "../shared/queryTypes.js";

export interface RegisteredMetric {
  type: "ratio" | "aggregation" | "derived";
  /**
   * Arithmetic expression over the metric names, e.g. "resigned_count / employee_count".
   */
  formula: string;
  /**
   * Low-level metrics that must be computed to evaluate the formula.
   */
  metrics: MetricFormulaMetric[];
}

/**
 * Registry of well-known business metrics.
 *
 * This keeps metric *definitions* close to the code while all natural language
 * understanding (which metric to use, when to use it) is still handled by the LLM.
 */
export const metricsRegistry: Record<string, RegisteredMetric> = {
  /**
   * Employee attrition rate:
   * - resigned_count: number of employees where Resigned? = "Yes"
   * - employee_count: total number of employees (masked_e_code rows)
   * - attrition_rate = resigned_count / employee_count
   */
  attrition_rate: {
    type: "ratio",
    formula: "resigned_count / employee_count",
    metrics: [
      {
        name: "resigned_count",
        aggregation: "count",
        column: "Resigned?",
        filter: { column: "Resigned?", operator: "=", value: "Yes" },
      },
      {
        name: "employee_count",
        aggregation: "count",
        column: "masked_e_code",
      },
    ],
  },
};

