/** User-message heuristic for report / dashboard / export style questions. Keep in sync with client `src/lib/reportIntent.ts`. */
export const REPORT_USER_INTENT_RE =
  /\b(report|dashboard|pptx?|pdf|export|slide|deck|executive\s+summary)\b/i;

export function userMessageHasReportIntent(text: string): boolean {
  return REPORT_USER_INTENT_RE.test(text);
}
