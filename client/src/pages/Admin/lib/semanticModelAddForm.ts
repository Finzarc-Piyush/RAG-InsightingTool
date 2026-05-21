/**
 * Wave W61-add-client · pure formatters for the per-kind Add-entry
 * modal on the admin semantic-model viewer.
 *
 * Pure module — no React, no DOM, no `window`, no fetch. Every helper
 * is deterministic on its inputs so `node --test` can pin them without
 * a jsdom mount. The modal component consumes these helpers; the
 * round-trip to the W61-add-server endpoint lives in the host's
 * `handleAdd`, not here.
 *
 * Mirrors the `semanticModelDeleteConfirmation.ts` precedent (pure
 * helpers + a sibling component + paired test file) so the W61 trail
 * stays consistent: formatting that bites if it drifts (the per-kind
 * noun, the singular submit-button verb, the quote-wrapped collision
 * message anchor copy) is testable in isolation.
 *
 * **Why a separate `parseHierarchyLevels`**
 *
 * Hierarchy `levels` is a `min(2).max(8)` string array per the server
 * schema. The natural authoring shape is a single textarea with one
 * level per line; the parser splits, trims, and drops empty lines.
 * Pulling the parser into the pure module lets the test pin the
 * boundary behaviour (trailing newline, leading whitespace, blank
 * lines, single-line input that should still parse to a one-element
 * array) without mounting the modal's React tree.
 */

import type { AdminSemanticModelEntryKind } from "@/lib/api/admin";

/**
 * Map an `AdminSemanticModelEntryKind` to its display noun. Lowercase
 * because the noun is consumed inline in sentences (`"A metric named
 * 'alpha' already exists"`, `"Add a new metric"`) — title-case would
 * read as a proper-noun.
 *
 * Duplicates the same helper in `semanticModelDeleteConfirmation.ts`
 * intentionally — each W61 modal owns its own kindNoun so the strings
 * stay scoped to their context and a future per-modal noun divergence
 * (e.g. "Add a new measure" instead of "Add a new metric") doesn't
 * cascade across the page.
 */
function kindNoun(kind: AdminSemanticModelEntryKind): string {
  switch (kind) {
    case "metric":
      return "metric";
    case "dimension":
      return "dimension";
    case "hierarchy":
      return "hierarchy";
  }
}

/**
 * Title for the Add-entry `<DialogTitle>`. The kind's noun is woven
 * inline; the headline is statement form (not question form like
 * delete's `"Delete metric \"x\"?"`) because the user is initiating an
 * action rather than confirming a destructive one.
 */
export function buildAddHeadline(kind: AdminSemanticModelEntryKind): string {
  return `Add a new ${kindNoun(kind)}`;
}

/**
 * Label for the submit button. Two-state copy: `"Add metric"` when
 * idle, `"Adding metric…"` when the parent mutation is in flight (so
 * the admin sees the round-trip is live).
 *
 * Trailing ellipsis on the in-flight form is intentional — Unicode
 * `…` (U+2026) not three dots, so the literal-string assertion in
 * the test catches a regression if a future refactor uses `...`.
 */
export function buildAddSubmitLabel(
  kind: AdminSemanticModelEntryKind,
  submitting: boolean,
): string {
  const noun = kindNoun(kind);
  return submitting ? `Adding ${noun}…` : `Add ${noun}`;
}

/**
 * Inline error string surfaced under the name field when the server
 * returns a 409 `name_already_exists`. The entry name is quoted so the
 * admin can read the collision target verbatim; the "in this session"
 * scope makes it clear the namespace is per-session (a metric "x" in
 * another session is irrelevant).
 *
 * The anchor copy `"Choose a different name."` is pinned by the test
 * so a future shorter rewrite (e.g. `"Rename and try again."`) is
 * forced through the test as an explicit change.
 */
export function formatNameCollisionError(
  kind: AdminSemanticModelEntryKind,
  name: string,
): string {
  return (
    `A ${kindNoun(kind)} named "${name}" already exists in this session. ` +
    `Choose a different name.`
  );
}

/**
 * Parse the hierarchy levels textarea (one level per line) into a
 * trimmed-non-empty string array. Leading / trailing whitespace per
 * line is dropped; blank lines are filtered out so a stray Enter
 * keystroke doesn't break the parse.
 *
 * Does NOT validate snake_case on each level — that's the caller's
 * responsibility (the form runs `validateName` on each parsed level
 * + the `levels.length >= 2` schema bound). Returns the raw split so
 * the form can show a "Level N: <error>" message per-level when one
 * fails.
 */
export function parseHierarchyLevels(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
