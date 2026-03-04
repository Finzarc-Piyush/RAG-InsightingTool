import { DataSummary } from "../../shared/schema.js";

/**
 * High-level business concepts that managers typically ask about
 * for HR / people-analytics style datasets.
 */
export type HRBusinessConcept =
  | "attrition"
  | "reassignment"
  | "tenure"
  | "headcount"
  | "unknown";

/**
 * Configuration for how a given HR concept tends to appear
 * in real-world CSV / table schemas.
 */
export interface HRConceptConfig {
  id: HRBusinessConcept;
  /**
   * Natural language phrases managers might use.
   * Example: "resigned", "left the company", "attrition".
   */
  synonyms: string[];
  /**
   * Hints for matching against column names in the dataset.
   * Example: "Resigned?", "Attrition", "Exit Flag".
   */
  columnHints: string[];
  /**
   * Typical values that mean a positive / \"true\" case for this concept.
   * Example: [\"Yes\", \"Y\", 1, true] for a yes/no attrition flag.
   */
  defaultPositiveValues?: any[];
}

/**
 * Per-dataset override saying \"for this chat, treat concept X
 * as column Y, optionally with a specific positive value\".
 */
export interface HRConceptOverride {
  concept: HRBusinessConcept;
  column: string;
  positiveValue?: any;
}

/**
 * Result of resolving a free-form manager question into a concrete
 * column + value for a given concept.
 */
export interface HRConceptResolution {
  concept: HRBusinessConcept;
  targetColumn?: string;
  /**
   * Value that represents the \"positive\" case for this concept,
   * e.g. \"Yes\" / \"Y\" / 1 for attrition flags.
   */
  positiveValue?: any;
  /**
   * 0–1 confidence used to decide whether to act automatically
   * or ask for clarification.
   */
  confidence: number;
  /**
   * Optional debugging / logging hint to understand why a
   * particular mapping was chosen.
   */
  reason?: string;
  /**
   * Whether this resolution came directly from a stored override.
   */
  viaOverride?: boolean;
}

/**
 * Static dictionary of HR concepts with common synonyms and
 * column-name patterns.
 *
 * This is intentionally small and opinionated; it can be extended
 * per-client later via overrides or additional config.
 */
export const hrConcepts: HRConceptConfig[] = [
  {
    id: "attrition",
    synonyms: [
      "attrition",
      "resigned",
      "resignations",
      "left the company",
      "left company",
      "quit",
      "churn",
      "turnover",
      "people who left",
      "employees who left"
    ],
    columnHints: [
      "resigned",
      "resigned?",
      "attrition",
      "attrition flag",
      "attrition (y/n)",
      "exit",
      "exit flag",
      "termination",
      "terminated"
    ],
    defaultPositiveValues: ["Yes", "Y", "True", "TRUE", 1, true]
  },
  {
    id: "reassignment",
    synonyms: [
      "reassigned",
      "reassignment",
      "transferred",
      "transfer",
      "moved role",
      "moved department",
      "role change",
      "internal move"
    ],
    columnHints: [
      "reassigned",
      "reassigned?",
      "reassignment flag",
      "transfer flag",
      "internal move",
      "internal transfer"
    ],
    defaultPositiveValues: ["Yes", "Y", "True", "TRUE", 1, true]
  },
  {
    id: "tenure",
    synonyms: [
      "tenure",
      "member tenure",
      "employee tenure",
      "length of service",
      "time in company",
      "years in company",
      "months in company",
      "service duration"
    ],
    columnHints: [
      "tenure",
      "member tenure",
      "employee tenure",
      "length of service",
      "service tenure",
      "years of service",
      "months of service"
    ]
  },
  {
    id: "headcount",
    synonyms: [
      "headcount",
      "number of employees",
      "employee count",
      "staff count",
      "people count",
      "how many people",
      "how many employees"
    ],
    columnHints: [
      // Often headcount is implicit (row count), but some datasets
      // have an explicit headcount column.
      "headcount",
      "employee count",
      "staff count"
    ]
  },
  {
    id: "unknown",
    synonyms: [],
    columnHints: []
  }
];

/**
 * Convenience helper to get a list of columns that look
 * boolean-like based on the summary (few distinct sample values,
 * typical yes/no patterns, etc.).
 */
export function getBooleanLikeColumns(summary: DataSummary): string[] {
  const booleanish: string[] = [];

  for (const col of summary.columns || []) {
    const values = col.sampleValues || [];
    const unique = Array.from(
      new Set(
        values
          .filter((v) => v !== null && v !== undefined && `${v}`.trim() !== "")
          .map((v) => `${v}`.trim())
      )
    );

    if (unique.length === 0 || unique.length > 10) continue;

    const lowerValues = unique.map((v) => v.toLowerCase());
    const looksYesNo =
      (lowerValues.includes("yes") && lowerValues.includes("no")) ||
      (lowerValues.includes("y") && lowerValues.includes("n")) ||
      (lowerValues.includes("true") && lowerValues.includes("false")) ||
      (unique.includes("1") && unique.includes("0")) ||
      (unique.includes("1") && unique.includes("2")); // some HR datasets use 1/2 coding

    if (looksYesNo) {
      booleanish.push(col.name);
    }
  }

  return booleanish;
}

/**
 * Find the HRConceptConfig entry for a given concept id.
 */
export function getHRConceptConfig(id: HRBusinessConcept): HRConceptConfig | undefined {
  return hrConcepts.find((c) => c.id === id);
}

/**
 * Heuristic resolver that tries to infer which HR concept the user
 * is talking about and which column/value should be used, based on:
 * - The natural language message
 * - The dataset's DataSummary (column names + sample values)
 * - Optional per-session overrides
 */
export function resolveHRConceptFromMessage(
  message: string,
  summary: DataSummary,
  overrides?: HRConceptOverride[]
): HRConceptResolution {
  const lowerMsg = message.toLowerCase();

  // Quick exit if message doesn't look HR-related at all
  if (!/\b(resign|resigned|attrition|tenure|headcount|reassign|transfer|left|employees?|people)\b/i.test(lowerMsg)) {
    return {
      concept: "unknown",
      confidence: 0,
      reason: "No obvious HR-related keywords detected in message."
    };
  }

  // 1) Score each concept based on synonym matches in the message
  let bestConcept: HRBusinessConcept = "unknown";
  let bestConceptScore = 0;

  for (const concept of hrConcepts) {
    if (concept.id === "unknown") continue;

    let score = 0;
    for (const phrase of concept.synonyms) {
      const phraseLower = phrase.toLowerCase();
      if (lowerMsg.includes(phraseLower)) {
        // Weight by phrase length so \"attrition\" > \"left\"
        score += Math.min(phraseLower.length / 10, 2);
      }
    }

    if (score > bestConceptScore) {
      bestConceptScore = score;
      bestConcept = concept.id;
    }
  }

  if (bestConcept === "unknown" || bestConceptScore === 0) {
    return {
      concept: "unknown",
      confidence: 0,
      reason: "No concept synonyms matched the message."
    };
  }

  // 2) Determine candidate column from overrides first
  const conceptOverride = overrides?.find((o) => o.concept === bestConcept);
  const booleanLikeColumns = getBooleanLikeColumns(summary);

  let targetColumn: string | undefined;
  let viaOverride = false;
  let columnScore = 0;

  if (conceptOverride) {
    targetColumn = conceptOverride.column;
    viaOverride = true;
    columnScore = 2.0; // strong signal
  } else {
    // Heuristic search across dataset columns using columnHints and synonyms
    const conceptConfig = getHRConceptConfig(bestConcept);
    if (conceptConfig) {
      for (const col of summary.columns || []) {
        const nameLower = col.name.toLowerCase();

        // Prefer boolean-like columns for attrition / reassignment
        const isBooleanish = booleanLikeColumns.includes(col.name);

        let score = 0;

        for (const hint of conceptConfig.columnHints) {
          const hintLower = hint.toLowerCase();
          if (nameLower === hintLower) {
            score += 3;
          } else if (nameLower.includes(hintLower)) {
            score += 1.5;
          }
        }

        // Fallback: if column name contains any synonym words
        for (const phrase of conceptConfig.synonyms) {
          const phraseLower = phrase.toLowerCase();
          if (nameLower.includes(phraseLower)) {
            score += 1;
          }
        }

        if (isBooleanish) {
          score += 0.75;
        }

        if (score > columnScore) {
          columnScore = score;
          targetColumn = col.name;
        }
      }
    }
  }

  // 3) Determine positiveValue by inspecting sample values
  let positiveValue: any | undefined = conceptOverride?.positiveValue;
  const conceptConfig = getHRConceptConfig(bestConcept);

  if (!positiveValue && targetColumn && conceptConfig) {
    const colSummary = summary.columns.find((c) => c.name === targetColumn);
    const sampleValues = colSummary?.sampleValues || [];
    const unique = Array.from(
      new Set(
        sampleValues
          .filter((v) => v !== null && v !== undefined && `${v}`.trim() !== "")
          .map((v) => `${v}`.trim())
      )
    );
    const lowerUnique = unique.map((v) => v.toLowerCase());

    // Try to pick from configured defaults if they appear in sample values
    if (conceptConfig.defaultPositiveValues && conceptConfig.defaultPositiveValues.length > 0) {
      for (const candidate of conceptConfig.defaultPositiveValues) {
        const candidateStr = `${candidate}`.trim();
        const candidateLower = candidateStr.toLowerCase();

        if (lowerUnique.includes(candidateLower)) {
          positiveValue = unique[lowerUnique.indexOf(candidateLower)];
          break;
        }
      }
    }

    // Fallback: guess a yes-like value
    if (!positiveValue) {
      const yesLike = unique.find((v) => {
        const l = v.toLowerCase();
        return l === "yes" || l === "y" || l === "true" || l === "t" || l === "1";
      });
      positiveValue = yesLike ?? conceptConfig.defaultPositiveValues?.[0];
    }
  }

  // 4) Compute an overall confidence score between 0 and 1
  const rawConceptScore = bestConceptScore; // roughly 0–something
  const rawColumnScore = columnScore;
  const combined = rawConceptScore + rawColumnScore;

  // Normalize using a soft cap to keep within [0, 1]
  const confidence = Math.max(0, Math.min(combined / 6, 1));

  return {
    concept: bestConcept,
    targetColumn,
    positiveValue,
    confidence,
    reason: viaOverride
      ? `Used stored override for concept "${bestConcept}" and column "${targetColumn}".`
      : `Best concept "${bestConcept}" with heuristic column match "${targetColumn ?? "none"}".`,
    viaOverride
  };
}


