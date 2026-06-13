/**
 * Collision-safe composite Map keys.
 *
 * Several modules build a single Map key out of multiple field values (e.g.
 * `${x}<sep>${series}`). Each had independently picked its own control-char
 * delimiter (NUL, SOH, Unit Separator), which (a) duplicated the idea and
 * (b) embedded raw control bytes in source, classifying the files as binary
 * and hiding them from ripgrep. This is the one shared definition.
 *
 * `KEY_SEP` is the ASCII Unit Separator (U+001F) — a non-printable control
 * character that never appears in real tabular data, so it cannot collide
 * with a field value. Always build AND decompose keys via these helpers so
 * the two sides can never drift apart.
 */
export const KEY_SEP = "\u001f";

/** Join field values into one collision-safe composite key. */
export function compositeKey(...parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(KEY_SEP);
}

/** Split a composite key back into its parts (inverse of {@link compositeKey}). */
export function splitCompositeKey(key: string): string[] {
  return key.split(KEY_SEP);
}
