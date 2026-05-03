import { formatKMB, formatCurrency } from "@/lib/charts/format";
import { parseNumericCell } from "@/lib/formatAnalysisNumber";

const NUMBER_TOKEN_RE =
  /(-?)([$₹£€¥])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;

const THRESHOLD = 1000;

const SKIP_PREV_CHAR_RE = /[A-Za-z0-9._=/:#]/;
const SKIP_NEXT_CHAR_RE = /[A-Za-z0-9_]/;

export function compactizeNumbersInText(text: string): string {
  if (!text) return text;
  return text.replace(
    NUMBER_TOKEN_RE,
    (
      match: string,
      sign: string,
      symbol: string | undefined,
      digits: string,
      offset: number,
    ) => {
      const prevChar = offset > 0 ? text[offset - 1] : "";
      if (prevChar && SKIP_PREV_CHAR_RE.test(prevChar)) return match;

      const endIdx = offset + match.length;
      const nextChar = endIdx < text.length ? text[endIdx] : "";
      if (nextChar === "%") return match;
      if (nextChar && SKIP_NEXT_CHAR_RE.test(nextChar)) return match;

      const parsed = parseNumericCell(`${sign}${symbol ?? ""}${digits}`);
      if (parsed === null) return match;
      if (Math.abs(parsed) < THRESHOLD) return match;

      if (symbol) {
        return formatCurrency(parsed, symbol, 1);
      }

      if (
        !sign &&
        !digits.includes(",") &&
        !digits.includes(".") &&
        /^\d{4}$/.test(digits)
      ) {
        const intVal = parseInt(digits, 10);
        if (intVal >= 1900 && intVal <= 2099) return match;
      }

      return formatKMB(parsed, 1);
    },
  );
}
