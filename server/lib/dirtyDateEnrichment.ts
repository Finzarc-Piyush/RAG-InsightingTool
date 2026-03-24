import { z } from 'zod';
import type { DatasetProfile } from '../shared/schema.js';
import { isLikelyIdentifierColumnName } from './columnIdHeuristics.js';

const mappingBatchSchema = z.object({
  mappings: z.array(
    z.object({
      raw: z.string(),
      iso: z.string().nullable(),
    })
  ),
});

export function cleanedColumnNameForSource(source: string, existingKeys: Set<string>): string {
  const base = `Cleaned_${source}`;
  if (!existingKeys.has(base)) return base;
  let i = 2;
  while (existingKeys.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/** Deterministic source → cleaned header names from column order before enrichment. */
export function computeCleanedDateColumnNames(
  originalColumns: string[],
  profile: DatasetProfile
): Map<string, string> {
  const dirty = new Set(profile.dirtyStringDateColumns ?? []);
  const dates = new Set(profile.dateColumns ?? []);
  const orderedDirty = originalColumns.filter(
    (c) => dirty.has(c) && dates.has(c) && !isLikelyIdentifierColumnName(c)
  );
  const keySet = new Set(originalColumns);
  const out = new Map<string, string>();
  for (const source of orderedDirty) {
    const cleaned = cleanedColumnNameForSource(source, keySet);
    keySet.add(cleaned);
    out.set(source, cleaned);
  }
  return out;
}

function collectDistinctStrings(data: Record<string, any>[], source: string, max: number): string[] {
  const seen = new Set<string>();
  for (const row of data) {
    if (seen.size >= max) break;
    const v = row[source];
    if (v == null || v === '') continue;
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function valueForCleanedCell(
  raw: unknown,
  map: Map<string, string | null>
): string | number | Date | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) return raw;
  if (typeof raw !== 'string') return String(raw);
  const t = raw.trim();
  if (!t) return null;
  if (!map.has(t)) return raw;
  const iso = map.get(t);
  if (iso === null || iso === undefined) return raw;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? raw : d;
}

const BATCH_SYSTEM = `You map messy business date and period strings to ISO-8601.
Return ONLY JSON: { "mappings": [ { "raw": "<exact input>", "iso": "<ISO8601 string>" | null } ] }.
There must be exactly one mapping per input value; "raw" must match the given string exactly (after trim).
Use null for iso when the value is not a parseable date/period or is hopelessly ambiguous.
For calendar quarters use the first day of the quarter (Q1 -> ...-01-01). For months use the first day of the month.
For fiscal or hybrid labels (e.g. H1 Q1), pick a consistent representative calendar date and apply it to all similar rows.
Prefer YYYY-MM-DD when no time is implied; otherwise full ISO instant.`;

export type DirtyDateMapBatchFn = (args: {
  sourceColumn: string;
  fileName?: string;
  values: string[];
}) => Promise<{ ok: true; map: Map<string, string | null> } | { ok: false; error: string }>;

async function defaultMapBatch(args: {
  sourceColumn: string;
  fileName?: string;
  values: string[];
}): Promise<{ ok: true; map: Map<string, string | null> } | { ok: false; error: string }> {
  const { completeJson } = await import('./agents/runtime/llmJson.js');
  const user = JSON.stringify({
    fileName: args.fileName,
    sourceColumn: args.sourceColumn,
    values: args.values,
  });
  const out = await completeJson(BATCH_SYSTEM, user, mappingBatchSchema, {
    maxTokens: 2048,
    temperature: 0.1,
    turnId: 'dirty_date_map_batch',
  });
  if (!out.ok) return { ok: false, error: out.error };
  const map = new Map<string, string | null>();
  for (const m of out.data.mappings) {
    map.set(m.raw, m.iso);
  }
  for (const v of args.values) {
    if (!map.has(v)) {
      return { ok: false, error: `missing mapping for raw value: ${v.slice(0, 80)}` };
    }
  }
  return { ok: true, map };
}

async function buildColumnMap(
  data: Record<string, any>[],
  source: string,
  options: { fileName?: string; maxUniques: number; batchSize: number; mapBatch: DirtyDateMapBatchFn }
): Promise<Map<string, string | null> | null> {
  const uniques = collectDistinctStrings(data, source, options.maxUniques);
  const merged = new Map<string, string | null>();
  const batches = chunk(uniques, options.batchSize);
  for (const b of batches) {
    if (b.length === 0) continue;
    const res = await options.mapBatch({
      sourceColumn: source,
      fileName: options.fileName,
      values: b,
    });
    if (!res.ok) {
      console.warn(`⚠️ dirtyDateEnrichment: batch failed for "${source}": ${res.error}`);
      return null;
    }
    for (const [k, v] of res.map.entries()) merged.set(k, v);
  }
  return merged;
}

function rebuildRowsWithCleaned(
  data: Record<string, any>[],
  originalColumnOrder: string[],
  successes: { source: string; cleaned: string; map: Map<string, string | null> }[]
): void {
  const bySource = new Map(successes.map((s) => [s.source, s]));
  for (let i = 0; i < data.length; i++) {
    const row = data[i]!;
    const out: Record<string, any> = {};
    for (const k of originalColumnOrder) {
      out[k] = row[k];
      const s = bySource.get(k);
      if (s) out[s.cleaned] = valueForCleanedCell(row[k], s.map);
    }
    data[i] = out;
  }
}

/**
 * Adds Cleaned_* columns for profile.dirtyStringDateColumns via batched LLM mapping.
 * Mutates `data` rows in place. On column failure, skips that column (no Cleaned_* added).
 */
export async function enrichDirtyStringDateColumns(
  data: Record<string, any>[],
  profile: DatasetProfile,
  originalColumnOrder: string[],
  options?: { fileName?: string; mapBatch?: DirtyDateMapBatchFn }
): Promise<void> {
  if (!data.length) return;
  const dirty = profile.dirtyStringDateColumns ?? [];
  if (!dirty.length) return;

  const sourceToCleaned = computeCleanedDateColumnNames(originalColumnOrder, profile);
  if (sourceToCleaned.size === 0) return;

  const maxUniques = Number(process.env.DIRTY_DATE_MAX_UNIQUES) || 3000;
  const batchSize = Number(process.env.DIRTY_DATE_LLM_BATCH_SIZE) || 70;
  const mapBatch = options?.mapBatch ?? ((args) => defaultMapBatch(args));

  const successes: { source: string; cleaned: string; map: Map<string, string | null> }[] = [];

  for (const [source, cleaned] of sourceToCleaned) {
    if (!originalColumnOrder.includes(source)) continue;
    const colMap = await buildColumnMap(data, source, {
      fileName: options?.fileName,
      maxUniques,
      batchSize,
      mapBatch,
    });
    if (!colMap) {
      console.warn(`⚠️ dirtyDateEnrichment: skipped Cleaned_* for "${source}" (LLM mapping failed)`);
      continue;
    }
    successes.push({ source, cleaned, map: colMap });
  }

  if (successes.length === 0) return;
  rebuildRowsWithCleaned(data, originalColumnOrder, successes);
}
