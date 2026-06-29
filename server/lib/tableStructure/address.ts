// Spreadsheet A1-style address helpers (0-based grid indices in, 1-based
// human-facing addresses out). Used by rationales and the LLM corner map.

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function colLetter(col0: number): string {
  let n = col0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** (row0, col0) → "B3". */
export function cellAddr(row0: number, col0: number): string {
  return `${colLetter(col0)}${row0 + 1}`;
}
