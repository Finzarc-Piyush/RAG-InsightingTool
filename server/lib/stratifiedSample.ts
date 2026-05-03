/**
 * Wave C5 · Stratified sampling + categorical-association rendering.
 *
 * Replaces "first-N" sampling for prompts with a stratified pick that
 * guarantees rare categorical values still surface. When the planner needs
 * "show me 100 sample rows", we balance across the high-association
 * categorical columns so the LLM sees the long tail too.
 */
import type { SchemaIndex, AssociationEntry } from "./schemaIndex.js";

export interface StratifySpec {
  /** Categorical columns to balance across (most-associated first). */
  columns: string[];
  /** Total rows desired. Each stratum gets at least one row when possible. */
  limit: number;
}

/**
 * Stratified sample: groups rows by the cross-product of `stratify.columns`
 * values, picks proportionally with a min-1-per-stratum guarantee until
 * `limit` is hit.
 */
export function stratifiedSample(
  rows: ReadonlyArray<Record<string, unknown>>,
  stratify: StratifySpec
): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const limit = Math.max(1, Math.floor(stratify.limit));
  if (stratify.columns.length === 0) return rows.slice(0, limit) as Record<string, unknown>[];

  // Bucketise.
  const buckets = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = stratify.columns.map((c) => String(row[c] ?? "∅")).join("‖");
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(row);
  }
  if (buckets.size === 0) return [];

  // Pass 1: one row from each stratum (round-robin head-of-bucket).
  const out: Record<string, unknown>[] = [];
  for (const arr of buckets.values()) {
    if (out.length >= limit) break;
    if (arr.length > 0) out.push(arr.shift() as Record<string, unknown>);
  }
  if (out.length >= limit) return out;

  // Pass 2: fill remaining proportionally.
  const remaining = limit - out.length;
  const totalLeft = Array.from(buckets.values()).reduce((s, a) => s + a.length, 0);
  if (totalLeft === 0) return out;
  for (const arr of buckets.values()) {
    if (out.length >= limit) break;
    const share = Math.max(0, Math.floor((remaining * arr.length) / totalLeft));
    for (let i = 0; i < share && out.length < limit && arr.length > 0; i++) {
      out.push(arr.shift() as Record<string, unknown>);
    }
  }

  // Top-up: round-robin pick from any remaining buckets until we hit limit.
  let idx = 0;
  const bucketArrays = Array.from(buckets.values()).filter((a) => a.length > 0);
  while (out.length < limit && bucketArrays.some((a) => a.length > 0)) {
    const bucket = bucketArrays[idx % bucketArrays.length];
    if (bucket.length > 0) out.push(bucket.shift() as Record<string, unknown>);
    idx++;
    if (idx > limit * 4) break; // safety
  }
  return out;
}

/**
 * Render the categorical-association block for a planner prompt.
 *
 * Given a SchemaIndex, surfaces categorical pairs with Cramér's V > 0.3 so
 * the planner knows which dimensions are confounded ("Region and Channel
 * are correlated; controlling for one needs the other").
 */
export function formatCategoricalAssociationsBlock(
  index: SchemaIndex | undefined,
  threshold: number = 0.3
): string {
  if (!index) return "";
  const strong: AssociationEntry[] = index.associations.filter(
    (a) => a.cramersV >= threshold
  );
  if (strong.length === 0) return "";
  const lines = strong
    .slice(0, 12)
    .map(
      (a) =>
        `  ${a.a} ↔ ${a.b}: V=${a.cramersV.toFixed(2)} (n=${a.n})`
    )
    .join("\n");
  return `\n### CATEGORICAL_ASSOCIATIONS (Cramér's V ≥ ${threshold}; treat as confounding hints — controlling for one of a strongly-associated pair often requires controlling for the other):\n${lines}\n`;
}
