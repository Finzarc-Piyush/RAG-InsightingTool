import { z } from "zod";

/**
 * Shape of a curated question used by the LLM-routing A/B harness. Sourced
 * from the `past_analyses` Cosmos container (seeded via
 * `scripts/seed-golden-questions.ts`) filtered to `feedback = "up"` + diverse
 * `outcome` + spread across common patterns (trend, comparison, breakdown,
 * lookup, etc.).
 */
export const goldenQuestionSchema = z.object({
  /** Stable id, typically `${sessionId}__${turnId}` from the source doc. */
  id: z.string(),
  /** The raw user question. */
  question: z.string(),
  /** Question shape tag (manually curated or inferred from analysisBrief). */
  shape: z.enum([
    "lookup",
    "breakdown",
    "trend",
    "comparison",
    "correlation",
    "root_cause",
    "other",
  ]),
  /**
   * Optional labels describing the dataset, e.g. "sales", "marketing",
   * "operations". Used to ensure the harness stays balanced across domains.
   */
  tags: z.array(z.string()).default([]),
  /**
   * Baseline answer captured under the all-PRIMARY config. Harness compares
   * new configs against this string via similarity metrics + chart-count +
   * outcome diff.
   */
  baselineAnswer: z.string(),
  baselineChartCount: z.number().int().nonnegative(),
  baselineOutcome: z.enum([
    "ok",
    "verifier_failed",
    "budget_exceeded",
    "tool_error",
  ]),
  /** Cost in USD for the baseline run (for before/after savings delta). */
  baselineCostUsd: z.number().nonnegative(),
  /** Snapshot metadata. */
  sessionId: z.string(),
  dataVersion: z.number().int().nonnegative(),
  capturedAt: z.number(),
});
export type GoldenQuestion = z.infer<typeof goldenQuestionSchema>;

export const goldenCorpusSchema = z.object({
  version: z.literal(1),
  generatedAt: z.number(),
  /** Config name the baselines were captured under (e.g. "all-primary"). */
  baselineConfig: z.string(),
  questions: z.array(goldenQuestionSchema),
});
export type GoldenCorpus = z.infer<typeof goldenCorpusSchema>;
