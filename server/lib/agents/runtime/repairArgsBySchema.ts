/**
 * repairArgsBySchema.ts — deterministic, schema-driven repair of planner tool args.
 *
 * THE BUG IT FIXES. The planner LLM occasionally emits tool args that fail Zod
 * validation in two common, RECOVERABLE ways:
 *   1. An extra key a `.strict()` schema rejects — e.g. `detect_seasonality`
 *      with `periodKind` → Zod `unrecognized_keys`.
 *   2. A bad value for an OPTIONAL enum field — e.g. `compute_growth` with
 *      `aggregation: "count"` (enum is sum|avg|min|max) → `invalid_enum_value`.
 * Either one aborts the whole turn ("the agent produced a plan that could not be
 * run") even though every other arg is fine.
 *
 * THE FIX. Inspect the Zod `safeParse` issues and apply SAFE repairs — only ever
 * DELETING offending keys, never inventing values: drop unrecognized keys, and
 * drop bad-value keys so the schema's (or the tool's downstream) default applies.
 * Re-parse after each pass; bounded iterations.
 *
 * SAFETY (fail-forward, mirrors booleanIndicatorRateRepair). The single source of
 * truth is the FINAL `safeParse`: we return repaired args ONLY if they now pass,
 * else `null`. Deleting a REQUIRED field therefore self-corrects to a no-op (the
 * re-parse fails → we return null → the caller falls through to the existing
 * reject/retry path). We deliberately do NOT introspect Zod optionality —
 * "delete then re-validate" is simpler and strictly safe. The caller's object is
 * never mutated (we operate on a clone).
 */
import type { z } from "zod";

type PathSeg = string | number;

function pathLabel(path: ReadonlyArray<PathSeg>): string {
  return path.map((p) => String(p)).join(".");
}

/** Descend to the container at `path` (defensive; never throws). The empty path
 *  returns the root. Returns undefined if any branch is missing or non-object. */
function walkPath(root: unknown, path: ReadonlyArray<PathSeg>): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PathSeg, unknown>)[seg];
  }
  return cur;
}

/** Delete `key` from the object container at `path`. Returns true if removed. */
function deleteAtPath(
  root: unknown,
  path: ReadonlyArray<PathSeg>,
  key: PathSeg
): boolean {
  const container = walkPath(root, path);
  if (container == null || typeof container !== "object") return false;
  const obj = container as Record<PathSeg, unknown>;
  if (!(key in obj)) return false;
  delete obj[key];
  return true;
}

/**
 * Attempt to repair `rawArgs` so they satisfy `schema`, by deleting offending
 * keys reported by Zod. Returns the repaired args (only if they now validate) or
 * `null`, plus a human-readable list of the changes made.
 */
export function repairArgsBySchema(
  schema: z.ZodTypeAny,
  rawArgs: Record<string, unknown>,
  maxPasses = 4
): { args: Record<string, unknown> | null; changes: string[] } {
  // Deep clone so the caller's object is never mutated.
  const work = structuredClone(rawArgs) as Record<string, unknown>;
  const changes: string[] = [];

  for (let pass = 0; pass < maxPasses; pass++) {
    const res = schema.safeParse(work);
    if (res.success) return { args: work, changes };

    let deletedThisPass = false;
    for (const issue of res.error.issues) {
      if (issue.code === "unrecognized_keys") {
        // `path` points at the CONTAINING object; `keys` are the bad props.
        for (const k of issue.keys) {
          if (deleteAtPath(work, issue.path, k)) {
            changes.push(`removed unknown key "${pathLabel([...issue.path, k])}"`);
            deletedThisPass = true;
          }
        }
      } else if (
        issue.code === "invalid_enum_value" ||
        issue.code === "invalid_literal"
      ) {
        // `path` points AT the field; delete it from its parent so any default
        // (schema-level or tool-downstream) applies instead.
        const path = issue.path;
        if (path.length === 0) continue; // can't delete the root itself
        const key = path[path.length - 1];
        if (deleteAtPath(work, path.slice(0, -1), key)) {
          changes.push(`removed invalid value at "${pathLabel(path)}"`);
          deletedThisPass = true;
        }
      }
    }
    if (!deletedThisPass) break; // nothing actionable left — stop early
  }

  // Final guard: accept the repaired args ONLY if they now pass validation.
  const final = schema.safeParse(work);
  return final.success ? { args: work, changes } : { args: null, changes };
}
