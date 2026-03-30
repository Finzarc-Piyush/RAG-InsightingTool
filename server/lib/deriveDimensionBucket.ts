import { z } from "zod";
import type { DataSummary } from "../shared/schema.js";

export const deriveDimensionBucketArgsSchema = z
  .object({
    sourceColumn: z.string().min(1).max(200),
    newColumnName: z.string().min(1).max(200),
    buckets: z
      .array(
        z.object({
          label: z.string().min(1).max(200),
          values: z.array(z.string().min(1)).min(1).max(500),
        })
      )
      .min(1)
      .max(40),
    matchMode: z.enum(["exact", "case_insensitive"]).optional(),
    defaultLabel: z.string().min(1).max(200).optional(),
  })
  .strict();

export type DeriveDimensionBucketArgs = z.infer<typeof deriveDimensionBucketArgsSchema>;

function normalizeCell(s: string, mode: "exact" | "case_insensitive"): string {
  return mode === "case_insensitive" ? s.trim().toLowerCase() : s;
}

/**
 * Adds `newColumnName` by mapping `sourceColumn` cell values into bucket labels.
 * Rows are shallow-copied; original data is not mutated.
 */
export function applyDeriveDimensionBucket(
  data: Record<string, any>[],
  summary: DataSummary,
  args: DeriveDimensionBucketArgs
): { ok: true; rows: Record<string, any>[] } | { ok: false; error: string } {
  const allowed = new Set(summary.columns.map((c) => c.name));
  if (!allowed.has(args.sourceColumn)) {
    return { ok: false, error: `Column not in schema: ${args.sourceColumn}` };
  }
  if (summary.columns.some((c) => c.name === args.newColumnName)) {
    return {
      ok: false,
      error: `Column "${args.newColumnName}" already exists; choose a new name.`,
    };
  }

  const mode = args.matchMode ?? "exact";
  const lookup: { label: string; keys: Set<string> }[] = args.buckets.map((b) => ({
    label: b.label,
    keys: new Set(b.values.map((v) => normalizeCell(String(v), mode))),
  }));

  const rows = data.map((row) => {
    const out = { ...row };
    const raw = row[args.sourceColumn];
    const cell = raw === null || raw === undefined ? "" : String(raw);
    const key = normalizeCell(cell, mode);
    let label: string | undefined;
    for (const b of lookup) {
      if (b.keys.has(key)) {
        label = b.label;
        break;
      }
    }
    if (label === undefined) {
      label =
        args.defaultLabel !== undefined ? args.defaultLabel : cell === "" ? "Other" : cell;
    }
    out[args.newColumnName] = label;
    return out;
  });

  return { ok: true, rows };
}

export function registerDerivedColumnOnSummary(
  summary: DataSummary,
  newColumnName: string,
  sampleFromRows: Record<string, any>[],
  maxSamples = 8
): void {
  if (summary.columns.some((c) => c.name === newColumnName)) return;
  const samples: (string | number)[] = [];
  const seen = new Set<string>();
  for (const row of sampleFromRows) {
    const v = row[newColumnName];
    if (v === null || v === undefined) continue;
    const s = String(v);
    if (seen.has(s) || samples.length >= maxSamples) continue;
    seen.add(s);
    samples.push(s);
  }
  summary.columns.push({
    name: newColumnName,
    type: "string",
    sampleValues: samples,
  });
}
