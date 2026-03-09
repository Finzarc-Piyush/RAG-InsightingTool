import type { DataSummary, Message } from "../shared/schema.js";

export type QuestionType = "data_question" | "general_question" | "mixed_question";

interface ClassificationDebugInfo {
  hasColumnMention: boolean;
  hasHRMetricKeyword: boolean;
  hasDatasetKeyword: boolean;
  hasWorldKeyword: boolean;
}

const HR_METRIC_KEYWORDS = [
  "attrition",
  "turnover",
  "resignation",
  "resignations",
  "resigned",
  "left the company",
  "headcount",
  "tenure",
  "member tenure",
  "payout ratio",
  "achievement",
  "quarter achievement"
];

const DATASET_KEYWORDS = [
  "in this dataset",
  "in the dataset",
  "in this data",
  "in our data",
  "in marico",
  "in this file",
  "in this table",
  "in the table",
  "from the upload",
  "in my data"
];

const WORLD_QUESTION_PATTERNS: RegExp[] = [
  /\bwho\s+is\b/i,
  /\bwho\s+was\b/i,
  /\bwho\s+won\b/i,
  /\bwhat\s+is\s+the\s+capital\b/i,
  /\bwhere\s+is\b/i,
  /\bwhen\s+did\b/i,
  /\bpresident\s+of\b/i,
  /\bprime\s+minister\s+of\b/i,
  /\bgdp\s+of\b/i,
  /\bpopulation\s+of\b/i
];

function analyzeQuestionText(
  question: string,
  summary: DataSummary
): ClassificationDebugInfo {
  const lower = question.toLowerCase();

  let hasColumnMention = false;
  for (const col of summary.columns || []) {
    const name = col.name;
    if (!name) continue;
    const lowerName = name.toLowerCase();
    if (lower.includes(lowerName)) {
      hasColumnMention = true;
      break;
    }
    // Also try a relaxed form without spaces/underscores
    const normalizedName = lowerName.replace(/[\s_-]/g, "");
    if (normalizedName.length >= 3 && lower.replace(/[\s_-]/g, "").includes(normalizedName)) {
      hasColumnMention = true;
      break;
    }
  }

  const hasHRMetricKeyword = HR_METRIC_KEYWORDS.some((kw) =>
    lower.includes(kw)
  );

  const hasDatasetKeyword = DATASET_KEYWORDS.some((kw) =>
    lower.includes(kw)
  );

  const hasWorldKeyword = WORLD_QUESTION_PATTERNS.some((re) => re.test(question));

  return {
    hasColumnMention,
    hasHRMetricKeyword,
    hasDatasetKeyword,
    hasWorldKeyword
  };
}

/**
 * Classify a question as:
 * - data_question: primarily about the uploaded dataset
 * - general_question: open-domain / world knowledge, not tied to the dataset
 * - mixed_question: combines dataset and world knowledge (e.g. compare Marico vs industry)
 */
export function classifyQuestion(
  question: string,
  summary: DataSummary,
  chatHistory: Message[] = []
): QuestionType {
  const q = (question || "").trim();
  if (!q) {
    // Empty question – default to data_question since the UI is usually in a dataset context
    return "data_question";
  }

  const { hasColumnMention, hasHRMetricKeyword, hasDatasetKeyword, hasWorldKeyword } =
    analyzeQuestionText(q, summary);

  // Look for recent context indicating dataset focus or world focus
  const recentHistory = chatHistory.slice(-5).map((m) => m.content.toLowerCase());
  const historyMentionsDataset = recentHistory.some((c) =>
    DATASET_KEYWORDS.some((kw) => c.includes(kw))
  );

  const historyMentionsWorld = recentHistory.some((c) =>
    WORLD_QUESTION_PATTERNS.some((re) => re.test(c))
  );

  const looksDataLike =
    hasColumnMention || hasHRMetricKeyword || hasDatasetKeyword || historyMentionsDataset;

  const looksWorldLike = hasWorldKeyword || historyMentionsWorld;

  if (looksDataLike && looksWorldLike) {
    return "mixed_question";
  }

  if (looksDataLike) {
    return "data_question";
  }

  if (looksWorldLike) {
    return "general_question";
  }

  // Default: if we have a dataset loaded, treat ambiguous questions as data-related
  if (summary && summary.columnCount > 0) {
    return "data_question";
  }

  return "general_question";
}

