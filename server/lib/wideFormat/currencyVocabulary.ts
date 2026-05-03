// Currency vocabulary — recognise leading/trailing currency symbols on
// numeric values and return the matching ISO 4217 code.
//
// Used at upload time to (a) strip the symbol from string values so
// the parser can convert them to numbers, and (b) attach a per-column
// currency tag to `ColumnInfo.currency` so downstream rendering knows
// to format with the correct symbol.
//
// Ambiguous symbols (`$`, `kr`, `¥`) get a default ISO that can be
// overridden by the LLM dataset-profile prompt at WF8.

export type CurrencyPosition = "prefix" | "suffix";

export interface CurrencyMatch {
  /** Raw symbol as it appeared in the value (e.g. "đ", "R$", "kr"). */
  symbol: string;
  /** ISO 4217 code (e.g. "VND", "BRL", "SEK"). */
  isoCode: string;
  /** Where the symbol sat relative to the digits. */
  position: CurrencyPosition;
  /** 0..1 — votes-agreement ratio across sample values. */
  confidence: number;
}

// Symbol → ISO map. Order matters for symbols that share a prefix
// (e.g. "R$" must be tested before "R", "S$" before "$", "HK$" before
// "$"). Multi-character symbols are listed first.
//
// "?" suffix in the ISO column marks ambiguous defaults that the LLM
// can override at WF8 (e.g. `$` → USD by default, but could be CAD,
// AUD, SGD, HKD, etc.).
const SYMBOL_TABLE: Array<{ symbol: string; iso: string }> = [
  // Compound / multi-character — must come first so "R$123" doesn't
  // match the bare "R" or bare "$" entries.
  { symbol: "R$", iso: "BRL" },
  { symbol: "S$", iso: "SGD" },
  { symbol: "HK$", iso: "HKD" },
  { symbol: "NT$", iso: "TWD" },
  { symbol: "A$", iso: "AUD" },
  { symbol: "C$", iso: "CAD" },
  { symbol: "Mex$", iso: "MXN" },
  { symbol: "RM", iso: "MYR" },
  { symbol: "Rp", iso: "IDR" },
  { symbol: "kr", iso: "SEK" }, // ambiguous: SEK / DKK / NOK
  { symbol: "zł", iso: "PLN" },
  { symbol: "Kč", iso: "CZK" },
  { symbol: "Ft", iso: "HUF" },
  { symbol: "Lei", iso: "RON" },
  { symbol: "лв", iso: "BGN" },
  { symbol: "د.إ", iso: "AED" },
  { symbol: "ر.س", iso: "SAR" },
  { symbol: "RUB", iso: "RUB" },
  // Single-character.
  { symbol: "đ", iso: "VND" },
  { symbol: "$", iso: "USD" }, // ambiguous default
  { symbol: "€", iso: "EUR" },
  { symbol: "£", iso: "GBP" },
  { symbol: "¥", iso: "JPY" }, // ambiguous: JPY / CNY
  { symbol: "₹", iso: "INR" },
  { symbol: "₩", iso: "KRW" },
  { symbol: "₪", iso: "ILS" },
  { symbol: "₺", iso: "TRY" },
  { symbol: "฿", iso: "THB" },
  { symbol: "₦", iso: "NGN" },
  { symbol: "₱", iso: "PHP" },
  { symbol: "₴", iso: "UAH" },
  { symbol: "₫", iso: "VND" }, // alternative đồng symbol
  { symbol: "₿", iso: "BTC" },
];

/** Currency symbols whose ISO code is genuinely ambiguous and the
 * LLM should be asked to disambiguate at WF8. */
export const AMBIGUOUS_SYMBOLS = new Set(["$", "kr", "¥"]);

/**
 * Attempt to peel a leading or trailing currency symbol off a single
 * value. Returns null when no symbol matches.
 *
 * Also strips thousand separators (`,` and `.` when used as
 * thousand-grouping in European notation) and the percent sign so the
 * remaining string is a parseable number. Whitespace and underscores
 * inside the digit run are tolerated.
 */
export function stripCurrencyAndParse(
  value: string
): { num: number; symbol: string | null; position: CurrencyPosition | null } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try prefix symbols first (most common: "$123", "đ131,000").
  for (const { symbol } of SYMBOL_TABLE) {
    if (trimmed.startsWith(symbol)) {
      const rest = trimmed.slice(symbol.length).trim();
      const num = parseNumeric(rest);
      if (num !== null) {
        return { num, symbol, position: "prefix" };
      }
    }
  }
  // Then suffix symbols ("123 kr", "1.234,56 €").
  for (const { symbol } of SYMBOL_TABLE) {
    if (trimmed.endsWith(symbol)) {
      const rest = trimmed.slice(0, trimmed.length - symbol.length).trim();
      const num = parseNumeric(rest);
      if (num !== null) {
        return { num, symbol, position: "suffix" };
      }
    }
  }
  // No currency symbol — try plain numeric parse (with thousand-sep,
  // percent, whitespace handling).
  const num = parseNumeric(trimmed);
  if (num !== null) {
    return { num, symbol: null, position: null };
  }
  return null;
}

/** Plain numeric parse with thousand-separator + percent tolerance.
 * Returns null on failure. */
function parseNumeric(s: string): number | null {
  if (!s) return null;
  // Strip percent, thousand-separator commas, whitespace, underscores,
  // dashes used as separators (em-dash, en-dash, hyphen-minus).
  // Preserve negative sign and decimal point.
  const cleaned = s
    .replace(/[%,\s_]/g, "")
    .replace(/^[–—―]/, "-")
    .trim();
  if (!cleaned) return null;
  // Reject if anything other than digits / one decimal / one leading
  // sign remains.
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return num;
}

/** Look up the ISO code for a symbol; returns null if unknown. */
export function isoForSymbol(symbol: string): string | null {
  for (const entry of SYMBOL_TABLE) {
    if (entry.symbol === symbol) return entry.iso;
  }
  return null;
}

/**
 * Detect a single currency for a sample of column values. Votes over
 * up to `MAX_SAMPLES` strings; returns the dominant `{symbol, iso,
 * position}` if ≥ `THRESHOLD` agree, else null (multi-currency or
 * non-currency column).
 */
const MAX_SAMPLES = 200;
const THRESHOLD = 0.8;

export function detectCurrencyInValues(samples: unknown[]): CurrencyMatch | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const tally = new Map<string, { count: number; iso: string; symbol: string; position: CurrencyPosition }>();
  let totalParseable = 0;
  let totalWithSymbol = 0;
  const limit = Math.min(samples.length, MAX_SAMPLES);

  for (let i = 0; i < limit; i++) {
    const raw = samples[i];
    if (raw == null) continue;
    const s = typeof raw === "string" ? raw : String(raw);
    const parsed = stripCurrencyAndParse(s);
    if (parsed === null) continue;
    totalParseable++;
    if (parsed.symbol === null) continue;
    totalWithSymbol++;
    const iso = isoForSymbol(parsed.symbol);
    if (!iso) continue;
    const key = `${parsed.symbol}|${parsed.position}`;
    const entry = tally.get(key);
    if (entry) {
      entry.count++;
    } else {
      tally.set(key, {
        count: 1,
        iso,
        symbol: parsed.symbol,
        position: parsed.position!,
      });
    }
  }

  if (totalWithSymbol === 0) return null;

  let best: { count: number; iso: string; symbol: string; position: CurrencyPosition } | null = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return null;
  // The dominant symbol must agree on at least THRESHOLD of *symbol-bearing*
  // values. A column with mixed currencies returns null.
  const ratio = best.count / totalWithSymbol;
  if (ratio < THRESHOLD) return null;
  return {
    symbol: best.symbol,
    isoCode: best.iso,
    position: best.position,
    confidence: ratio,
  };
}
