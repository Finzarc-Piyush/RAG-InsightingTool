/**
 * Wave W61-source-bump · auto-mark edited entries as `source: "user"`
 * on the admin PATCH path.
 *
 * The W57 inference pipeline writes every metric / dimension /
 * hierarchy with `source: "auto"`. Domain packs (W59c, future) write
 * `source: "domain"`. The third literal, `"user"`, was reserved for
 * admin-edited entries but never set — the W61-save controller
 * preserved whatever `source` the client sent (almost always `"auto"`
 * because the client mirrors the prior model and the only edits land
 * on content fields, not on `source`). The planner reads `source`
 * via [`buildSemanticCatalogPromptBlock`](./prompt.ts) to weight
 * entries (manually-corrected ones outrank inferred ones); without
 * this bump, every admin correction was invisible to the weighting.
 *
 * Rule: per-entry content equality (everything except `source`).
 *   - **Unchanged** entry: preserve the prior `source` (auto stays
 *     auto, domain stays domain, user stays user).
 *   - **Changed** entry: bump to `"user"`. Whatever the prior source
 *     was, the admin's edit makes this a user-authored entry.
 *   - **New** entry (no prior match by `name`): preserve the
 *     client-sent `source`. The schema's default is `"user"`; if a
 *     future "add metric" flow lets an admin import from a pack,
 *     the client can send `"domain"` and the server preserves it.
 *
 * Content equality uses an explicit field-projection hash rather
 * than `JSON.stringify(entry)` (which would also stringify `source`
 * and force a non-equal hash on a no-op save — defeating the point).
 */

import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
} from "../../shared/schema.js";

const USER_SOURCE = "user" as const;

function contentHashMetric(m: SemanticMetric): string {
  return JSON.stringify({
    label: m.label,
    expression: m.expression,
    references: m.references,
    format: m.format,
    currencyCode: m.currencyCode,
    decimals: m.decimals,
    description: m.description,
    exposed: m.exposed,
  });
}

function contentHashDimension(d: SemanticDimension): string {
  return JSON.stringify({
    label: d.label,
    column: d.column,
    kind: d.kind,
    temporalGrain: d.temporalGrain,
    description: d.description,
    exposed: d.exposed,
  });
}

function contentHashHierarchy(h: SemanticHierarchy): string {
  return JSON.stringify({
    label: h.label,
    levels: h.levels,
    description: h.description,
  });
}

function bumpEntries<T extends { name: string; source: "auto" | "user" | "domain" }>(
  next: ReadonlyArray<T>,
  prior: ReadonlyArray<T>,
  hash: (e: T) => string,
): T[] {
  const priorByName = new Map(prior.map((e) => [e.name, e]));
  return next.map((entry) => {
    const previous = priorByName.get(entry.name);
    if (!previous) return entry;
    if (hash(entry) === hash(previous)) {
      return { ...entry, source: previous.source };
    }
    return { ...entry, source: USER_SOURCE };
  });
}

export function bumpMetricsSource(
  next: ReadonlyArray<SemanticMetric>,
  prior: ReadonlyArray<SemanticMetric>,
): SemanticMetric[] {
  return bumpEntries(next, prior, contentHashMetric);
}

export function bumpDimensionsSource(
  next: ReadonlyArray<SemanticDimension>,
  prior: ReadonlyArray<SemanticDimension>,
): SemanticDimension[] {
  return bumpEntries(next, prior, contentHashDimension);
}

export function bumpHierarchiesSource(
  next: ReadonlyArray<SemanticHierarchy>,
  prior: ReadonlyArray<SemanticHierarchy>,
): SemanticHierarchy[] {
  return bumpEntries(next, prior, contentHashHierarchy);
}
