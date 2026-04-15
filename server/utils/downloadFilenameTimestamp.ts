/**
 * UTC timestamp safe for filenames: YYYY-MM-DD_HHmmss (no colons).
 */
export function downloadFilenameTimestamp(d: Date = new Date()): string {
  const iso = d.toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!m) return iso.replace(/[:.Z]/g, "").slice(0, 15);
  return `${m[1]}_${m[2]}${m[3]}${m[4]}`;
}
