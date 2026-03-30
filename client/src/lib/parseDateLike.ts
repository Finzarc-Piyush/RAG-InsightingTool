/** Month abbreviations for loose "Apr-24" style parsing (shared preview / table sort). */
const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Timestamp (ms) or null — used for date-aware sorting in data previews. */
export function parseDateLike(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  const str = String(value).trim();
  if (!str) return null;

  const mmmYyMatch = str.match(/^([A-Za-z]{3,})[-\s/]?(\d{2,4})$/i);
  if (mmmYyMatch) {
    const monthName = mmmYyMatch[1].toLowerCase().substring(0, 3);
    const month = MONTH_MAP[monthName];
    if (month !== undefined) {
      let year = parseInt(mmmYyMatch[2], 10);
      if (year < 100) {
        year = year <= 30 ? 2000 + year : 1900 + year;
      }
      return new Date(year, month, 1).getTime();
    }
  }

  const native = new Date(str);
  if (!isNaN(native.getTime())) return native.getTime();
  return null;
}
