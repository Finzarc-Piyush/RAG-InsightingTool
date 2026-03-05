import type { DataSummary } from "../../shared/schema.js";
import {
  resolveHRConceptFromMessage,
  type HRConceptResolution
} from "./hrConcepts.js";

export interface HRMetricResult {
  concept: "attrition" | "reassignment";
  column: string;
  positiveValue: any;
  count: number;
  total: number;
  rate: number; // 0–1
  resolution: HRConceptResolution;
}

function countMatches(
  data: Record<string, any>[],
  column: string,
  positiveValue: any
): number {
  let matchCount = 0;
  for (const row of data) {
    const v = row[column];
    if (v === null || v === undefined || v === "") continue;

    if (typeof v === "string" || typeof positiveValue === "string") {
      const vStr = String(v).trim().toLowerCase();
      const posStr = String(positiveValue).trim().toLowerCase();
      if (vStr === posStr) {
        matchCount++;
      }
      continue;
    }

    if (
      (typeof v === "number" || typeof positiveValue === "number") &&
      !Number.isNaN(Number(v)) &&
      !Number.isNaN(Number(positiveValue))
    ) {
      if (Number(v) === Number(positiveValue)) {
        matchCount++;
      }
      continue;
    }

    if (v === positiveValue) {
      matchCount++;
    }
  }
  return matchCount;
}

function resolveFlagForConcept(
  conceptMessage: string,
  conceptId: "attrition" | "reassignment",
  summary: DataSummary
): HRConceptResolution | null {
  const res = resolveHRConceptFromMessage(conceptMessage, summary);
  if (
    res.concept === conceptId &&
    res.targetColumn &&
    res.positiveValue !== undefined &&
    res.confidence >= 0.5
  ) {
    return res;
  }
  return null;
}

export function computeAttritionMetrics(
  data: Record<string, any>[],
  summary: DataSummary
): HRMetricResult | null {
  if (!data || data.length === 0 || !summary || !summary.columns?.length) {
    return null;
  }

  const res =
    resolveFlagForConcept("attrition rate", "attrition", summary) ||
    resolveFlagForConcept("how many people have resigned", "attrition", summary);

  if (!res || !res.targetColumn) {
    return null;
  }

  const total = summary.rowCount || data.length;
  const count = countMatches(data, res.targetColumn, res.positiveValue);
  const rate = total > 0 ? count / total : 0;

  return {
    concept: "attrition",
    column: res.targetColumn,
    positiveValue: res.positiveValue,
    count,
    total,
    rate,
    resolution: res
  };
}

export function computeReassignmentMetrics(
  data: Record<string, any>[],
  summary: DataSummary
): HRMetricResult | null {
  if (!data || data.length === 0 || !summary || !summary.columns?.length) {
    return null;
  }

  const res =
    resolveFlagForConcept(
      "how many people have been reassigned",
      "reassignment",
      summary
    ) || resolveFlagForConcept("reassignment flag", "reassignment", summary);

  if (!res || !res.targetColumn) {
    return null;
  }

  const total = summary.rowCount || data.length;
  const count = countMatches(data, res.targetColumn, res.positiveValue);
  const rate = total > 0 ? count / total : 0;

  return {
    concept: "reassignment",
    column: res.targetColumn,
    positiveValue: res.positiveValue,
    count,
    total,
    rate,
    resolution: res
  };
}

