import { openai, MODEL } from "../../lib/openai.js";
import type { DatasetProfile } from "../../lib/queryPlanner.js";
import {
  QueryPlan,
  QueryFilter,
  QueryAggregation,
  QueryFilterOperator,
  QueryAggregationType,
} from "../../shared/queryTypes.js";
import type {
  BusinessSemanticIntent,
} from "../semantic/businessInterpreter.js";
import type { MetricDefinition } from "../semantic/metricResolver.js";

const ALLOWED_OPERATORS: QueryFilterOperator[] = [
  "=",
  ">",
  "<",
  ">=",
  "<=",
  "!=",
  "contains",
];

const ALLOWED_AGG_TYPES: QueryAggregationType[] = [
  "sum",
  "avg",
  "count",
  "min",
  "max",
];

export interface SemanticPlannerInput {
  semanticIntent: BusinessSemanticIntent;
  metricDefinition: MetricDefinition;
  datasetProfile: DatasetProfile;
}

function buildPlanFromMetricDefinition(
  metricDefinition: MetricDefinition,
  datasetProfile: DatasetProfile
): QueryPlan | null {
  if (
    !metricDefinition ||
    metricDefinition.metricType !== "aggregation" ||
    metricDefinition.aggregation !== "count" ||
    !metricDefinition.column
  ) {
    return null;
  }

  const allowedColumns = new Set(datasetProfile.columns.map((c) => c.name));
  const column = metricDefinition.column;
  if (!allowedColumns.has(column)) {
    return null;
  }

  const filters: QueryFilter[] = [];

  if (metricDefinition.condition) {
    // Very small parser for simple equality-style conditions coming from the LLM,
    // e.g. "Resigned? = 1", "Resigned? == 1", "Resigned? = 'Y'".
    const condition = metricDefinition.condition.trim();
    const eqMatch =
      condition.match(/^\s*([^\s=<>!]+)\s*([=!]=|=)\s*(.+)\s*$/) || null;
    if (eqMatch) {
      const [, colRaw, , valRaw] = eqMatch;
      const colName = colRaw.trim();
      if (allowedColumns.has(colName)) {
        let value: string | number | boolean | null = valRaw.trim();
        const colInfo = datasetProfile.columns.find(
          (c) => c.name === colName
        );

        // Normalize quotes
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        // If the LLM used semantic labels like "Yes"/"No" but the underlying
        // column is encoded as 0/1, map them to the closest numeric code based
        // on sampleValues. This keeps the behavior generic but avoids filters
        // that will never match any rows.
        if (
          typeof value === "string" &&
          colInfo &&
          Array.isArray(colInfo.sampleValues)
        ) {
          const rawSamples = colInfo.sampleValues.filter(
            (v) => v !== null && v !== undefined
          );
          const sampleSet = new Set(
            rawSamples.map((v) => String(v).toLowerCase().trim())
          );
          const hasZero = sampleSet.has("0");
          const hasOne = sampleSet.has("1");
          const lower = value.toLowerCase();

          if ((lower === "yes" || lower === "y" || lower === "true") && hasOne) {
            value = 1;
          } else if (
            (lower === "no" || lower === "n" || lower === "false") &&
            hasZero
          ) {
            value = 0;
          }
        }

        const asNumber = Number(value);
        if (!Number.isNaN(asNumber) && value !== "") {
          value = asNumber;
        } else if (
          typeof value === "string" &&
          (value.toLowerCase() === "true" || value.toLowerCase() === "false")
        ) {
          value = value.toLowerCase() === "true";
        }

        // If the condition used numeric 0/1 but the underlying column encodes
        // attrition as "Yes"/"No" (very common for HR datasets), remap the
        // numeric value back to the closest literal sample value so that the
        // filter actually matches rows in both Snowflake and in‑memory paths.
        if (
          typeof value === "number" &&
          colInfo &&
          Array.isArray(colInfo.sampleValues)
        ) {
          const rawSamples = colInfo.sampleValues.filter(
            (v) => v !== null && v !== undefined
          );
          const lowerSamples = rawSamples.map((v) =>
            String(v).toLowerCase().trim()
          );

          if (value === 1) {
            const idx = lowerSamples.findIndex((s) => s === "yes");
            if (idx !== -1) {
              value = rawSamples[idx] as string | number | boolean;
            }
          } else if (value === 0) {
            const idx = lowerSamples.findIndex((s) => s === "no");
            if (idx !== -1) {
              value = rawSamples[idx] as string | number | boolean;
            }
          }
        }

        filters.push({
          column: colName,
          operator: "=",
          value,
        });
      }
    }
  }

  const aggregations: QueryAggregation[] = [
    {
      column: column,
      type: "count",
    },
  ];

  return {
    action: "aggregate",
    filters,
    aggregations,
    groupBy: [],
    sortBy: undefined,
    limit: 1,
    requiresFullScan: true,
  };
}

/**
 * Convert a high-level semantic intent + metric definition into a concrete QueryPlan.
 *
 * This uses an LLM, but we *always* post-validate and clamp the plan
 * to allowed columns/operators/aggregations to keep it safe.
 */
export async function semanticToQueryPlan(
  input: SemanticPlannerInput
): Promise<QueryPlan | null> {
  const { semanticIntent, metricDefinition, datasetProfile } = input;

  // Fast path: for simple aggregation metrics (e.g. "how many people resigned"),
  // build the QueryPlan deterministically from the MetricDefinition without
  // asking a second LLM. This guarantees we honor the metricDefinition.condition
  // exactly (which was derived using dataset sample values) and avoids the
  // planner inventing literals like "Yes"/"No".
  const directPlan = buildPlanFromMetricDefinition(
    metricDefinition,
    datasetProfile
  );
  if (directPlan) {
    console.log(
      "🧠 semanticToQueryPlan: using direct plan from MetricDefinition:",
      JSON.stringify(directPlan)
    );
    return directPlan;
  }

  const allowedColumns = datasetProfile.columns.map((c) => c.name);

  const columnsDesc = datasetProfile.columns
    .map((c) => `- ${c.name} [${c.type}]`)
    .join("\n");

  const numericCols =
    datasetProfile.numericColumns.length > 0
      ? datasetProfile.numericColumns.join(", ")
      : "None";
  const dateCols =
    datasetProfile.dateColumns.length > 0
      ? datasetProfile.dateColumns.join(", ")
      : "None";

  const prompt = `
You are a strict query planner that converts business-level semantic intents
into a low-level QueryPlan for an analytics engine.

You MUST:
- Use ONLY the allowed columns from the dataset.
- Use ONLY allowed aggregation types and operators.
- Produce a single JSON object conforming exactly to the schema below.

DATASET PROFILE:
- Rows: ${datasetProfile.rowCount}
- Columns: ${datasetProfile.columnCount}

COLUMNS:
${columnsDesc}

NUMERIC COLUMNS: ${numericCols}
DATE COLUMNS: ${dateCols}

SEMANTIC INTENT:
${JSON.stringify(semanticIntent, null, 2)}

METRIC DEFINITION:
${JSON.stringify(metricDefinition, null, 2)}

ALLOWED FILTER OPERATORS: ${ALLOWED_OPERATORS.join(", ")}
ALLOWED AGG TYPES: ${ALLOWED_AGG_TYPES.join(", ")}
ALLOWED COLUMNS: ${allowedColumns.join(", ")}

QueryPlan JSON SCHEMA (all fields required but arrays may be empty, nulls allowed only where shown):
{
  "action": "aggregate" | "filter" | "groupby" | "topk" | "row_lookup",
  "filters": [
    {
      "column": string,
      "operator": "=" | ">" | "<" | ">=" | "<=" | "!=" | "contains",
      "value": string | number | boolean | null
    }
  ],
  "aggregations": [
    {
      "column": string,
      "type": "sum" | "avg" | "count" | "min" | "max"
    }
  ],
  "groupBy": string[],
  "sortBy": {
    "column": string,
    "direction": "asc" | "desc"
  } | null,
  "limit": number | null,
  "requiresFullScan": boolean
}

MAPPING GUIDANCE:
- For simple metric_query (e.g. "How many people resigned?"):
  - action: "aggregate"
  - aggregations: single aggregation using metricDefinition
  - groupBy: []
  - filters: from semanticIntent.filters and any metricDefinition.condition
- For comparison by a dimension (e.g. "Which department loses the most employees?"):
  - action: "aggregate"
  - aggregations: metricDefinition
  - groupBy: ["dimension_column"]  // map semantic dimension to actual column name
  - sortBy: descending on the aggregated column
  - limit: small (e.g. 5–20)
- For trend_analysis:
  - groupBy should include the appropriate time column.

CRITICAL:
- You MUST map semantic dimensions and metricDefinition.requiredColumns onto actual column names from the dataset.
- You MUST NOT invent new columns.
- If a semantic dimension can't be mapped, omit it from groupBy and keep the plan simple.

Return ONLY the JSON object, with no markdown or explanation.
`;

  try {
    const response = await openai.chat.completions.create({
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "You are a strict JSON query planner. Always respond with a single valid JSON object that matches the QueryPlan schema.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 700,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return null;
    }

    let raw: any;
    try {
      raw = JSON.parse(content);
    } catch (e) {
      console.warn("semanticToQueryPlan: failed to parse JSON:", e);
      return null;
    }

    // Post-validate and clamp to allowed schema
    const allowedSet = new Set(allowedColumns);

    const filters: QueryFilter[] = Array.isArray(raw.filters)
      ? raw.filters
          .map((f: any) => {
            if (!f || typeof f !== "object") return null;
            if (!allowedSet.has(String(f.column))) return null;
            if (!ALLOWED_OPERATORS.includes(f.operator)) return null;
            const val =
              typeof f.value === "string" ||
              typeof f.value === "number" ||
              typeof f.value === "boolean" ||
              f.value === null
                ? f.value
                : String(f.value);
            return {
              column: String(f.column),
              operator: f.operator as QueryFilterOperator,
              value: val,
            } as QueryFilter;
          })
          .filter((f: QueryFilter | null): f is QueryFilter => Boolean(f))
      : [];

    const aggregations: QueryAggregation[] = Array.isArray(raw.aggregations)
      ? raw.aggregations
          .map((a: any) => {
            if (!a || typeof a !== "object") return null;
            if (!allowedSet.has(String(a.column))) return null;
            if (!ALLOWED_AGG_TYPES.includes(a.type)) return null;
            return {
              column: String(a.column),
              type: a.type as QueryAggregationType,
            } as QueryAggregation;
          })
          .filter(
            (a: QueryAggregation | null): a is QueryAggregation => Boolean(a)
          )
      : [];

    const groupBy: string[] = Array.isArray(raw.groupBy)
      ? raw.groupBy
          .map((g: any) => String(g))
          .filter((g: string) => allowedSet.has(g))
      : [];

    let sortBy: QueryPlan["sortBy"] = undefined;
    if (raw.sortBy && typeof raw.sortBy === "object") {
      const col = String(raw.sortBy.column);
      if (allowedSet.has(col)) {
        sortBy = {
          column: col,
          direction: raw.sortBy.direction === "desc" ? "desc" : "asc",
        };
      }
    }

    let limit: number | undefined;
    if (typeof raw.limit === "number" && Number.isFinite(raw.limit)) {
      const n = Math.max(1, Math.floor(raw.limit));
      limit = Math.min(n, 10000);
    }

    const plan: QueryPlan = {
      action:
        raw.action === "filter" ||
        raw.action === "groupby" ||
        raw.action === "topk" ||
        raw.action === "row_lookup" ||
        raw.action === "aggregate"
          ? raw.action
          : "aggregate",
      filters,
      aggregations,
      groupBy,
      sortBy,
      limit,
      requiresFullScan:
        typeof raw.requiresFullScan === "boolean"
          ? raw.requiresFullScan
          : true,
    };

    return plan;
  } catch (error) {
    console.error("❌ semanticToQueryPlan failed:", error);
    return null;
  }
}

