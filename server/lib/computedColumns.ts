/**
 * Row-wise computed columns for the analysis agent (safe, schema-driven defs — no eval).
 */

import { z } from "zod";
import type { DataSummary } from "../shared/schema.js";
import { parseRowDate } from "./temporalFacetColumns.js";

const MS_PER_DAY = 86400000;

const numericBinaryOpSchema = z.enum(["add", "subtract", "multiply", "divide"]);

const computedColumnDefSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("date_diff_days"),
      startColumn: z.string().min(1).max(200),
      endColumn: z.string().min(1).max(200),
      clampNegative: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("numeric_binary"),
      op: numericBinaryOpSchema,
      leftColumn: z.string().min(1).max(200),
      rightColumn: z.string().min(1).max(200),
    })
    .strict(),
]);

export const addComputedColumnsArgsSchema = z
  .object({
    columns: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            def: computedColumnDefSchema,
          })
          .strict()
      )
      .min(1)
      .max(12),
    persistToSession: z.boolean().optional(),
    persistDescription: z.string().max(500).optional(),
  })
  .strict();

export type AddComputedColumnsArgs = z.infer<typeof addComputedColumnsArgsSchema>;
export type ComputedColumnDef = z.infer<typeof computedColumnDefSchema>;

function cellToNumber(value: unknown): number {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[%,]/g, "").trim();
  return Number(cleaned);
}

function computeCellValue(
  row: Record<string, unknown>,
  def: ComputedColumnDef
): number | null {
  if (def.type === "date_diff_days") {
    const a = parseRowDate(row[def.startColumn]);
    const b = parseRowDate(row[def.endColumn]);
    if (!a || !b) return null;
    const diffMs = b.getTime() - a.getTime();
    let days = Math.round(diffMs / MS_PER_DAY);
    if (def.clampNegative && days < 0) return null;
    return days;
  }
  const left = cellToNumber(row[def.leftColumn]);
  const right = cellToNumber(row[def.rightColumn]);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  switch (def.op) {
    case "add":
      return left + right;
    case "subtract":
      return left - right;
    case "multiply":
      return left * right;
    case "divide":
      if (right === 0) return null;
      return left / right;
    default:
      return null;
  }
}

function isNumericDef(def: ComputedColumnDef): boolean {
  return def.type === "date_diff_days" || def.type === "numeric_binary";
}

/** Per-column non-null counts for the newly-added computed columns. */
export type ComputedColumnNonNull = { name: string; nonNull: number; total: number };

function failureMessageForDef(name: string, def: ComputedColumnDef): string {
  if (def.type === "date_diff_days") {
    return `Computed column "${name}" produced null for every row. Check that "${def.startColumn}" and "${def.endColumn}" contain parseable dates (the source columns may be opaque/empty).`;
  }
  return `Computed column "${name}" produced null for every row. Check that "${def.leftColumn}" and "${def.rightColumn}" contain valid numbers.`;
}

/**
 * Append computed columns (shallow row copies). Validates schema column names and name collisions.
 * Returns per-column non-null counts so callers can surface coverage in tool results, and fails
 * fast when a column produces null for every row (silent date-parsing failure was a real bug).
 */
export function applyAddComputedColumns(
  data: Record<string, any>[],
  summary: DataSummary,
  args: AddComputedColumnsArgs
):
  | { ok: true; rows: Record<string, any>[]; nonNull: ComputedColumnNonNull[] }
  | { ok: false; error: string } {
  const allowed = new Set(summary.columns.map((c) => c.name));
  const existing = new Set(summary.columns.map((c) => c.name));

  for (const { name, def } of args.columns) {
    if (existing.has(name)) {
      return { ok: false, error: `Column "${name}" already exists; choose a new name.` };
    }
    existing.add(name);
    if (def.type === "date_diff_days") {
      if (!allowed.has(def.startColumn)) {
        return { ok: false, error: `Column not in schema: ${def.startColumn}` };
      }
      if (!allowed.has(def.endColumn)) {
        return { ok: false, error: `Column not in schema: ${def.endColumn}` };
      }
    } else if (def.type === "numeric_binary") {
      if (!allowed.has(def.leftColumn)) {
        return { ok: false, error: `Column not in schema: ${def.leftColumn}` };
      }
      if (!allowed.has(def.rightColumn)) {
        return { ok: false, error: `Column not in schema: ${def.rightColumn}` };
      }
    }
  }

  const nonNullCounts = new Map<string, number>(
    args.columns.map(({ name }) => [name, 0])
  );

  const rows = data.map((row) => {
    const out: Record<string, any> = { ...row };
    for (const { name, def } of args.columns) {
      const v = computeCellValue(row as Record<string, unknown>, def);
      out[name] = v;
      if (v !== null && v !== undefined && !Number.isNaN(v)) {
        nonNullCounts.set(name, (nonNullCounts.get(name) ?? 0) + 1);
      }
    }
    return out;
  });

  const total = rows.length;
  const nonNull: ComputedColumnNonNull[] = args.columns.map(({ name }) => ({
    name,
    nonNull: nonNullCounts.get(name) ?? 0,
    total,
  }));

  // Guard against silent date-parsing failures on real data: if a column produced
  // null for every row across a non-trivial dataset, the source columns are likely
  // unparseable (e.g. opaque DuckDB driver values, missing dates). Below the
  // threshold, treat all-null as legitimate (clampNegative on a tiny test, etc.).
  const NULL_GUARD_MIN_ROWS = 10;
  if (total >= NULL_GUARD_MIN_ROWS) {
    for (const { name, def } of args.columns) {
      if ((nonNullCounts.get(name) ?? 0) === 0) {
        return { ok: false, error: failureMessageForDef(name, def) };
      }
    }
  }

  return { ok: true, rows, nonNull };
}

/** Extend in-memory DataSummary so execute_query_plan sees new numeric columns. */
export function registerComputedColumnsOnSummary(
  summary: DataSummary,
  args: AddComputedColumnsArgs,
  sampleFromRows: Record<string, any>[]
): void {
  for (const { name, def } of args.columns) {
    if (summary.columns.some((c) => c.name === name)) continue;

    const samples: (string | number)[] = [];
    const seen = new Set<string>();
    for (const row of sampleFromRows) {
      const v = row[name];
      if (v === null || v === undefined || Number.isNaN(v)) continue;
      const s = String(v);
      if (seen.has(s) || samples.length >= 8) continue;
      seen.add(s);
      samples.push(typeof v === "number" ? v : Number(s));
    }

    if (isNumericDef(def)) {
      summary.columns.push({
        name,
        type: "number",
        sampleValues: samples.length ? samples : [null],
      });
      if (!summary.numericColumns.includes(name)) {
        summary.numericColumns.push(name);
      }
    }
  }
  summary.columnCount = summary.columns.length;
}

export function replaceSummaryFromFresh(summary: DataSummary, fresh: DataSummary): void {
  summary.rowCount = fresh.rowCount;
  summary.columnCount = fresh.columnCount;
  summary.columns = fresh.columns;
  summary.numericColumns = fresh.numericColumns;
  summary.dateColumns = fresh.dateColumns;
  summary.temporalFacetColumns = fresh.temporalFacetColumns;
}
