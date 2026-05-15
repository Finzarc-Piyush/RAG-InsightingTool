/**
 * Wave A5 · Apply a saved-column → new-column mapping to an automation
 * recipe before deterministic replay.
 *
 * Pure function. Given a `recipe` and a `mapping` (saved-name → new-name,
 * identity entries may be omitted), returns a deep-cloned recipe with
 * every column reference rewritten.
 *
 * Approach: structural rather than text-substitution. We walk known
 * "column-bearing" fields by name. This is more robust than regex on
 * stringified args (avoids breaking labels like "Sales by Region" that
 * happen to contain a column substring) at the cost of explicit per-tool
 * knowledge here. Worth it: the failure mode of a missed substitution is
 * a hard tool error at replay time (loud, halts cleanly via the replay
 * loop's error handler), whereas a *wrong* substitution would silently
 * corrupt analysis output (catastrophic).
 *
 * Substituted locations:
 *   • PlanStep.args fields: column, valueColumn, breakdownColumn,
 *     metricColumn, dateColumn, x, y, seriesColumn, groupBy[], columns[],
 *     dimensionFilters[].column, aggregations[].column, sort[].column,
 *     plan.{groupBy,aggregations[].column,dimensionFilters[].column,sort[].column},
 *     formula (regex word-boundary substitute on add_computed_columns),
 *     persistToSession columns[].name (the column being created can be a
 *     reserved name we should NOT remap — the mapping is for INPUT cols).
 *   • ChartSpec encoding: x, y, z, seriesColumn (top-level fields).
 *   • pivotDefaults: rows[], columns[], values[] (entries may be strings
 *     or {column, agg} objects — both handled), filterFields[],
 *     filterSelections (rename keys).
 *   • dashboardDraft: chart references inside sheets — recursive walk
 *     because the dashboard spec is large and nested.
 *
 * Identity-mapped columns (saved name === new name) are no-ops; the
 * function tolerates an empty mapping (returns a structural deep-clone).
 */

import type { AutomationTurn } from "../../shared/schema.js";

export type ColumnMapping = Record<string, string>;

/** Resolve one column name through the mapping; identity if absent. */
const remap = (name: unknown, mapping: ColumnMapping): string => {
  if (typeof name !== "string") return String(name ?? "");
  const mapped = mapping[name];
  return typeof mapped === "string" && mapped.length > 0 ? mapped : name;
};

/** Substitute column names inside a `formula` / `expression` string,
 *  matching whole-word references only. Saved column names are quoted
 *  for regex safety. Longest-first ordering avoids prefix collisions
 *  ("Sales" before "Sale" would otherwise rewrite "Sale" inside "Sales"). */
const substituteInFormula = (
  formula: string,
  mapping: ColumnMapping
): string => {
  const sortedKeys = Object.keys(mapping).sort(
    (a, b) => b.length - a.length
  );
  let out = formula;
  for (const key of sortedKeys) {
    if (key === mapping[key]) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Word boundary on each side; column names with spaces still match
    // because \b is between word and non-word, and a space at the edge
    // qualifies. For names containing spaces we anchor on lookarounds
    // to avoid partial-token matches.
    const safe = /\s/.test(key)
      ? new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g")
      : new RegExp(`\\b${escaped}\\b`, "g");
    out = out.replace(safe, mapping[key]);
  }
  return out;
};

const SCALAR_COLUMN_FIELDS = [
  "column",
  "valueColumn",
  "breakdownColumn",
  "metricColumn",
  "dateColumn",
  "periodColumn",
  "periodIsoColumn",
  "x",
  "y",
  "z",
  "seriesColumn",
  "sourceColumn",
] as const;

const ARRAY_OF_COLUMN_FIELDS = [
  "groupBy",
  "columns",
  "rows",
  "values",
  "filterFields",
] as const;

const remapStringArray = (
  arr: unknown,
  mapping: ColumnMapping
): unknown => {
  if (!Array.isArray(arr)) return arr;
  return arr.map((v) =>
    typeof v === "string" ? remap(v, mapping) : remapDeep(v, mapping)
  );
};

const remapDimensionFilters = (
  filters: unknown,
  mapping: ColumnMapping
): unknown => {
  if (!Array.isArray(filters)) return filters;
  return filters.map((f) => {
    if (!f || typeof f !== "object") return f;
    const cloned = { ...(f as Record<string, unknown>) };
    if (typeof cloned.column === "string") {
      cloned.column = remap(cloned.column, mapping);
    }
    return cloned;
  });
};

const remapAggregations = (aggs: unknown, mapping: ColumnMapping): unknown => {
  if (!Array.isArray(aggs)) return aggs;
  return aggs.map((a) => {
    if (!a || typeof a !== "object") return a;
    const cloned = { ...(a as Record<string, unknown>) };
    if (typeof cloned.column === "string") {
      cloned.column = remap(cloned.column, mapping);
    }
    return cloned;
  });
};

const remapSortClauses = (sort: unknown, mapping: ColumnMapping): unknown => {
  if (!Array.isArray(sort)) return sort;
  return sort.map((s) => {
    if (!s || typeof s !== "object") return s;
    const cloned = { ...(s as Record<string, unknown>) };
    if (typeof cloned.column === "string") {
      cloned.column = remap(cloned.column, mapping);
    }
    return cloned;
  });
};

const remapValuesArray = (
  values: unknown,
  mapping: ColumnMapping
): unknown => {
  if (!Array.isArray(values)) return values;
  return values.map((v) => {
    if (typeof v === "string") return remap(v, mapping);
    if (v && typeof v === "object") {
      const cloned = { ...(v as Record<string, unknown>) };
      if (typeof cloned.column === "string") {
        cloned.column = remap(cloned.column, mapping);
      }
      if (typeof cloned.field === "string") {
        cloned.field = remap(cloned.field, mapping);
      }
      return cloned;
    }
    return v;
  });
};

const remapFilterSelections = (
  selections: unknown,
  mapping: ColumnMapping
): unknown => {
  if (!selections || typeof selections !== "object" || Array.isArray(selections))
    return selections;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(selections as Record<string, unknown>)) {
    out[remap(k, mapping)] = v;
  }
  return out;
};

const remapAddComputedColumnsArgs = (
  args: Record<string, unknown>,
  mapping: ColumnMapping
): Record<string, unknown> => {
  const out = { ...args };
  if (Array.isArray(args.columns)) {
    out.columns = (args.columns as Record<string, unknown>[]).map((col) => {
      const colCloned = { ...col };
      // Do NOT remap `name` — that's the *new* column being created. If
      // the user mapped Sale→Sales upstream, the computed column "SaleK"
      // should still emit as "SaleK" (different column, same recipe).
      if (typeof colCloned.formula === "string") {
        colCloned.formula = substituteInFormula(colCloned.formula, mapping);
      }
      if (typeof colCloned.expression === "string") {
        colCloned.expression = substituteInFormula(
          colCloned.expression,
          mapping
        );
      }
      return colCloned;
    });
  }
  return out;
};

/** Generic deep walker for a nested args / spec object. Substitutes
 *  every known column-bearing field; recurses into objects and arrays. */
const remapDeep = (value: unknown, mapping: ColumnMapping): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => remapDeep(v, mapping));
  }
  if (typeof value !== "object") return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(obj)) {
    if ((SCALAR_COLUMN_FIELDS as readonly string[]).includes(key)) {
      out[key] = typeof raw === "string" ? remap(raw, mapping) : raw;
      continue;
    }
    if ((ARRAY_OF_COLUMN_FIELDS as readonly string[]).includes(key)) {
      out[key] = remapStringArray(raw, mapping);
      continue;
    }
    if (key === "values") {
      out[key] = remapValuesArray(raw, mapping);
      continue;
    }
    if (key === "dimensionFilters" || key === "filters") {
      out[key] = remapDimensionFilters(raw, mapping);
      continue;
    }
    if (key === "aggregations") {
      out[key] = remapAggregations(raw, mapping);
      continue;
    }
    if (key === "sort") {
      out[key] = remapSortClauses(raw, mapping);
      continue;
    }
    if (key === "filterSelections") {
      out[key] = remapFilterSelections(raw, mapping);
      continue;
    }
    if (key === "encoding" && raw && typeof raw === "object") {
      // Chart encoding has the same scalar fields plus possible `series`.
      out[key] = remapDeep(raw, mapping);
      continue;
    }
    out[key] = remapDeep(raw, mapping);
  }
  return out;
};

const remapPlanStep = (
  step: Record<string, unknown>,
  mapping: ColumnMapping
): Record<string, unknown> => {
  const tool = step.tool;
  const args = step.args;
  const argsObj =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};

  let newArgs: Record<string, unknown>;
  if (tool === "add_computed_columns") {
    // Custom because `columns[].name` must NOT be remapped.
    const partial = remapAddComputedColumnsArgs(argsObj, mapping);
    // Then walk the rest of the args generically (formula already handled).
    const stripped = { ...partial };
    delete stripped.columns;
    const generic = remapDeep(stripped, mapping) as Record<string, unknown>;
    newArgs = { ...generic, columns: partial.columns };
  } else {
    newArgs = remapDeep(argsObj, mapping) as Record<string, unknown>;
  }

  return { ...step, args: newArgs };
};

/**
 * Apply the mapping to an entire recipe. Returns a deep-cloned recipe;
 * the input is never mutated. If `mapping` is empty, the result is
 * structurally a deep clone (safe to hand to mutating downstream code).
 */
export const applyColumnMappingToRecipe = (
  recipe: AutomationTurn[],
  mapping: ColumnMapping
): AutomationTurn[] =>
  recipe.map((turn) => ({
    ...turn,
    planSteps: turn.planSteps.map((s) =>
      remapPlanStep(s as Record<string, unknown>, mapping)
    ),
    charts: turn.charts
      ? (turn.charts.map((c) => remapDeep(c, mapping)) as AutomationTurn["charts"])
      : undefined,
    pivotDefaults: turn.pivotDefaults
      ? (remapDeep(turn.pivotDefaults, mapping) as AutomationTurn["pivotDefaults"])
      : undefined,
    dashboardDraft: turn.dashboardDraft
      ? (remapDeep(turn.dashboardDraft, mapping) as AutomationTurn["dashboardDraft"])
      : undefined,
  }));

/**
 * Compute the saved-name → new-name mapping that the user/server has
 * agreed on, given:
 *   • exactMatches: saved names that exactly match a new-dataset column
 *     (identity, omit from mapping for cleanliness).
 *   • proposedMappings: from `automationRemap` (suggested by LLM),
 *     possibly edited by the user.
 *
 * Only entries with `suggested !== null && suggested !== saved` are
 * included in the returned mapping.
 */
export const composeColumnMapping = (
  exactMatches: string[],
  proposedMappings: { saved: string; suggested: string | null }[]
): ColumnMapping => {
  const out: ColumnMapping = {};
  // exactMatches are already identity; no mapping entry needed.
  for (const { saved, suggested } of proposedMappings) {
    if (typeof suggested !== "string" || suggested.length === 0) continue;
    if (suggested === saved) continue;
    out[saved] = suggested;
  }
  return out;
};
