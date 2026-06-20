/**
 * Wave C3/C4 · pure edit core for the (now editable) Executive Summary band.
 *
 * The band's six card groups all live on two persisted dashboard fields:
 *   - `answerEnvelope.{magnitudes,findings,implications,likelyDrivers,recommendations}`
 *   - the top-level `attentionAreas` array
 * This module owns the FIELD DESCRIPTORS (what the user edits per group), the
 * factory that turns a form's string values into a SCHEMA-VALID item (filling
 * the required-but-hidden fields like a recommendation's `rationale` or a
 * driver's basis-clamped `confidence`), and the immutable add/edit/delete
 * helpers that produce the `{ answerEnvelope?, attentionAreas? }` patch the
 * band sends through `dashboardsApi.patch`. Kept pure so it is the testable
 * seam; the band JSX + dialog stay thin.
 *
 * MUST stay aligned with `dashboardAnswerEnvelopeSchema` / `attentionAreaSchema`
 * (server/shared/schema/charts.ts) — the server validates against those, and a
 * wrong-object edit would be rejected (or, per L-021, silently stripped).
 */
import type {
  AttentionAreaSpec,
  DashboardAnswerEnvelope,
} from "@/shared/schema";

export type SummaryGroupKey =
  | "magnitudes"
  | "attentionAreas"
  | "findings"
  | "likelyDrivers"
  | "implications"
  | "recommendations";

export interface SummaryField {
  key: string;
  label: string;
  control: "text" | "textarea" | "select" | "number";
  options?: ReadonlyArray<{ value: string; label: string }>;
  optional?: boolean;
  placeholder?: string;
}

export interface SummaryGroupConfig {
  key: SummaryGroupKey;
  /** Where the array lives. */
  source: "envelope" | "attentionAreas";
  /** Singular noun for "Add …" buttons + dialog titles. */
  singular: string;
  /** Section heading (matches the read-only band labels). */
  heading: string;
  fields: ReadonlyArray<SummaryField>;
}

type Values = Record<string, string>;

const CONFIDENCE_BY_BASIS: Record<string, "low" | "medium" | "high"> = {
  data: "high",
  domain: "medium",
  general: "low",
};

/** The per-group field descriptors shown in the editor dialog. */
export const SUMMARY_GROUPS: Record<SummaryGroupKey, SummaryGroupConfig> = {
  magnitudes: {
    key: "magnitudes",
    source: "envelope",
    singular: "key number",
    heading: "Key numbers",
    fields: [
      { key: "value", label: "Value", control: "text", placeholder: "74.2%" },
      { key: "label", label: "Label", control: "text", placeholder: "female · survival rate" },
      {
        key: "confidence",
        label: "Confidence",
        control: "select",
        optional: true,
        options: [
          { value: "", label: "—" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
    ],
  },
  attentionAreas: {
    key: "attentionAreas",
    source: "attentionAreas",
    singular: "attention area",
    heading: "Attention areas",
    fields: [
      { key: "unit", label: "Unit", control: "text", placeholder: "S" },
      { key: "metric", label: "Metric", control: "text", placeholder: "survival_rate by Embarked" },
      { key: "dimension", label: "Dimension", control: "text", placeholder: "Embarked" },
      { key: "variancePct", label: "% below average", control: "number", placeholder: "-41" },
      {
        key: "status",
        label: "Status",
        control: "select",
        options: [
          { value: "amber", label: "Amber" },
          { value: "red", label: "Red" },
        ],
      },
    ],
  },
  findings: {
    key: "findings",
    source: "envelope",
    singular: "finding",
    heading: "Key findings",
    fields: [
      { key: "headline", label: "Headline", control: "text" },
      { key: "evidence", label: "Evidence", control: "textarea" },
      { key: "magnitude", label: "Magnitude", control: "text", optional: true, placeholder: "74.2% vs 18.9%" },
    ],
  },
  likelyDrivers: {
    key: "likelyDrivers",
    source: "envelope",
    singular: "explanation",
    heading: "Why it might be happening",
    fields: [
      { key: "explanation", label: "Explanation", control: "textarea" },
      {
        key: "basis",
        label: "Basis",
        control: "select",
        options: [
          { value: "data", label: "From the data" },
          { value: "domain", label: "Industry knowledge" },
          { value: "general", label: "General knowledge" },
        ],
      },
      {
        key: "testable",
        label: "Testable here",
        control: "select",
        optional: true,
        options: [
          { value: "", label: "No" },
          { value: "true", label: "Yes" },
        ],
      },
    ],
  },
  implications: {
    key: "implications",
    source: "envelope",
    singular: "implication",
    heading: "Why it matters",
    fields: [
      { key: "statement", label: "Statement", control: "textarea" },
      { key: "soWhat", label: "So what", control: "textarea" },
    ],
  },
  recommendations: {
    key: "recommendations",
    source: "envelope",
    singular: "priority action",
    heading: "Priority actions",
    fields: [
      { key: "action", label: "Action", control: "text" },
      {
        key: "horizon",
        label: "Horizon",
        control: "select",
        optional: true,
        options: [
          { value: "", label: "—" },
          { value: "now", label: "Now" },
          { value: "this_quarter", label: "This quarter" },
          { value: "strategic", label: "Strategic" },
        ],
      },
      { key: "expectedImpact", label: "Expected impact", control: "text", optional: true },
    ],
  },
};

export const SUMMARY_GROUP_ORDER: SummaryGroupKey[] = [
  "magnitudes",
  "attentionAreas",
  "findings",
  "likelyDrivers",
  "implications",
  "recommendations",
];

function clean(v: string | undefined): string {
  return (v ?? "").trim();
}

/** Build a schema-valid item from the dialog's string values, preserving any
 *  required-but-hidden fields from the item being edited (`prev`). */
export function makeSummaryItem(
  key: SummaryGroupKey,
  values: Values,
  prev?: Record<string, unknown>,
): Record<string, unknown> {
  switch (key) {
    case "magnitudes": {
      const item: Record<string, unknown> = {
        label: clean(values.label),
        value: clean(values.value),
      };
      if (clean(values.confidence)) item.confidence = values.confidence;
      return item;
    }
    case "attentionAreas": {
      const variancePct = Number(clean(values.variancePct)) || 0;
      return {
        dimension: clean(values.dimension),
        unit: clean(values.unit),
        metric: clean(values.metric),
        // value/benchmark are required by schema but not shown on the band; keep
        // whatever was there (edit) or default to 0 (manual add).
        value: typeof prev?.value === "number" ? prev.value : 0,
        benchmark: typeof prev?.benchmark === "number" ? prev.benchmark : 0,
        variancePct,
        status: values.status === "red" ? "red" : "amber",
      };
    }
    case "findings": {
      const item: Record<string, unknown> = {
        headline: clean(values.headline),
        evidence: clean(values.evidence),
      };
      if (clean(values.magnitude)) item.magnitude = clean(values.magnitude);
      return item;
    }
    case "likelyDrivers": {
      const basis = ["data", "domain", "general"].includes(values.basis)
        ? values.basis
        : "domain";
      const item: Record<string, unknown> = {
        explanation: clean(values.explanation),
        basis,
        // required by schema; the server's transform clamps it by basis anyway.
        confidence: CONFIDENCE_BY_BASIS[basis] ?? "medium",
      };
      if (values.testable === "true") item.testable = true;
      return item;
    }
    case "implications":
      return {
        statement: clean(values.statement),
        soWhat: clean(values.soWhat),
      };
    case "recommendations": {
      const item: Record<string, unknown> = {
        action: clean(values.action),
        // required by schema; not surfaced on the band — preserve or default "".
        rationale: typeof prev?.rationale === "string" ? prev.rationale : "",
      };
      if (clean(values.expectedImpact)) item.expectedImpact = clean(values.expectedImpact);
      if (clean(values.horizon)) item.horizon = values.horizon;
      return item;
    }
  }
}

/** Blank values for an ADD dialog: required selects default to their first
 *  option so the form is valid out of the gate; everything else starts empty. */
export function blankSummaryValues(key: SummaryGroupKey): Values {
  const out: Values = {};
  for (const f of SUMMARY_GROUPS[key].fields) {
    if (f.control === "select" && !f.optional) {
      out[f.key] = f.options?.[0]?.value ?? "";
    } else {
      out[f.key] = "";
    }
  }
  return out;
}

/** Extract editable string values from an existing item (for the edit dialog). */
export function summaryItemToValues(
  key: SummaryGroupKey,
  item: Record<string, unknown>,
): Values {
  const out: Values = {};
  for (const f of SUMMARY_GROUPS[key].fields) {
    const raw = item[f.key];
    if (f.key === "testable") out[f.key] = raw === true ? "true" : "";
    else out[f.key] = raw == null ? "" : String(raw);
  }
  return out;
}

/** The current array for a group (raw, uncapped). */
export function summaryGroupItems(
  key: SummaryGroupKey,
  envelope: DashboardAnswerEnvelope | undefined,
  attentionAreas: AttentionAreaSpec[] | undefined,
): Array<Record<string, unknown>> {
  if (key === "attentionAreas") {
    return (attentionAreas ?? []) as Array<Record<string, unknown>>;
  }
  return ((envelope?.[key] as unknown as Array<Record<string, unknown>>) ?? []);
}

export interface SummaryPatch {
  answerEnvelope?: DashboardAnswerEnvelope;
  attentionAreas?: AttentionAreaSpec[];
}

function patchFor(
  key: SummaryGroupKey,
  nextItems: Array<Record<string, unknown>>,
  envelope: DashboardAnswerEnvelope | undefined,
): SummaryPatch {
  if (SUMMARY_GROUPS[key].source === "attentionAreas") {
    return { attentionAreas: nextItems as unknown as AttentionAreaSpec[] };
  }
  return {
    answerEnvelope: {
      ...(envelope ?? {}),
      [key]: nextItems,
    } as DashboardAnswerEnvelope,
  };
}

/** Immutable add: append a new item built from the dialog values. */
export function addSummaryItem(
  key: SummaryGroupKey,
  values: Values,
  envelope: DashboardAnswerEnvelope | undefined,
  attentionAreas: AttentionAreaSpec[] | undefined,
): SummaryPatch {
  const items = summaryGroupItems(key, envelope, attentionAreas);
  const next = [...items, makeSummaryItem(key, values)];
  return patchFor(key, next, envelope);
}

/** Immutable edit: replace the item at `index`, preserving hidden fields. */
export function editSummaryItem(
  key: SummaryGroupKey,
  index: number,
  values: Values,
  envelope: DashboardAnswerEnvelope | undefined,
  attentionAreas: AttentionAreaSpec[] | undefined,
): SummaryPatch {
  const items = summaryGroupItems(key, envelope, attentionAreas);
  if (index < 0 || index >= items.length) return patchFor(key, items, envelope);
  const next = items.map((it, i) =>
    i === index ? makeSummaryItem(key, values, it) : it,
  );
  return patchFor(key, next, envelope);
}

/** Immutable delete: drop the item at `index`. */
export function deleteSummaryItem(
  key: SummaryGroupKey,
  index: number,
  envelope: DashboardAnswerEnvelope | undefined,
  attentionAreas: AttentionAreaSpec[] | undefined,
): SummaryPatch {
  const items = summaryGroupItems(key, envelope, attentionAreas);
  const next = items.filter((_, i) => i !== index);
  return patchFor(key, next, envelope);
}
