/**
 * Normalizes tool preview row cells before intermediate pivot hints so clients
 * never treat empty `{}` dimension values as a real grouping key (JSON "{}" row labels).
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function sanitizeIntermediateCellValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return v;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) return v;

  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return null;

  const unwrapKeys = ["value", "Value", "label", "Label"] as const;
  for (const uk of unwrapKeys) {
    if (keys.length === 1 && keys[0] === uk) {
      const inner = o[uk];
      if (inner === null || inner === undefined) return null;
      if (typeof inner !== "object" || inner instanceof Date) return inner;
    }
  }

  return v;
}

export function sanitizeIntermediatePreviewRows(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (!rows.length) return rows;
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = sanitizeIntermediateCellValue(v);
    }
    return out;
  });
}
