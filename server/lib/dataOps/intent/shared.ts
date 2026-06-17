/**
 * Shared context + parsing helpers for the per-operation data-ops intent
 * DETECTORS (ARCH-2 / CQ-2 god-file decomposition — second mega-function half).
 *
 * `parseDataOpsIntent` runs AI detection first, then an ORDER-SENSITIVE regex
 * fallback chain (FIRST-match-wins). Each per-operation regex block was moved
 * VERBATIM into `intent/detect<Op>.ts` as a pure function
 * `detect<Op>(ctx): DataOpsIntent | null`. `IntentDetectorContext` is the single
 * typed bag those detectors read; it carries only the message-derived values the
 * original inline blocks closed over (`message`, `lowerMessage`,
 * `availableColumns`). No session/Cosmos/python coupling — the regex paths are
 * pure message→intent.
 *
 * The replace-value helpers (`normalizeOldValue`, `normalizeNewValue`,
 * `extractReplaceValueIntent`) were inline closures over `availableColumns`;
 * they are moved here VERBATIM with `availableColumns` threaded explicitly.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import {
  extractCustomValue,
  findMentionedColumn,
} from "../dataOpsValueHelpers.js";

/**
 * The message-derived context every per-operation detector reads. Built once by
 * `parseDataOpsIntent` (`message`, its lowercased/trimmed form, and the list of
 * available column names) and passed to each detector in the ordered chain.
 */
export interface IntentDetectorContext {
  /** The raw user message (case-preserved — column matching is case-sensitive). */
  message: string;
  /** `message.toLowerCase().trim()` — the cheap keyword-gate surface. */
  lowerMessage: string;
  /** Available column names (`dataSummary.columns.map(c => c.name)`). */
  availableColumns: string[];
}

// ── replace_value helpers (moved VERBATIM from parseDataOpsIntent) ────────────

/** Helper function to normalize old value */
export function normalizeOldValue(val: string): any {
  val = val.replace(/^['"]|['"]$/g, '').trim();
  const lower = val.toLowerCase();
  if (lower === 'null' || lower === 'empty' || lower === 'blank') {
    return null;
  } else if (val === '-') {
    return '-';
  }
  return val;
}

/** Helper function to normalize new value */
export function normalizeNewValue(val: string): any {
  val = val.trim();
  // Remove trailing punctuation
  val = val.replace(/[.,;:!?]+$/, '');
  // Remove quotes
  val = val.replace(/^['"]|['"]$/g, '');

  // Try to parse as number
  if (/^-?\d+\.?\d*$/.test(val)) {
    const num = parseFloat(val);
    if (!isNaN(num) && isFinite(num)) {
      return num;
    }
  }

  // Handle null
  if (val.toLowerCase() === 'null') {
    return null;
  }

  // Try extractCustomValue as fallback
  const customResult = extractCustomValue(`with ${val}`);
  if (customResult.found) {
    return customResult.value;
  }

  return val;
}

/** Helper function to extract old and new values from various patterns */
export function extractReplaceValueIntent(
  msg: string,
  availableColumns: string[]
): { oldValue: any; newValue: any; column?: string } | null {
  // Pattern 1: "replace/remove/change X with/to/by Y"
  // Group 1: verb, Group 2: "the" (optional), Group 3: "value" (optional), Group 4: quote (optional),
  // Group 5: old value, Group 6: quote (optional), Group 7: "with/to/by", Group 8: new value
  let match = msg.match(/\b(replace|remove|change|substitute)\s+(the\s+)?(value\s+)?(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+(with|to|by)\s+(.+?)(?:\s|$|,|\.|;|in|for|instead)/i);
  if (match) {
    const oldVal = (match[5] || '').trim(); // Group 5 is the old value
    const newVal = (match[8] || '').trim(); // Group 8 is the new value
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 2: "replace/remove X with Y" (simpler)
  // Group 1: verb, Group 2: quote (optional), Group 3: old value, Group 4: quote (optional), Group 5: "with/to/by", Group 6: new value
  match = msg.match(/\b(replace|remove|change|substitute)\s+(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+(with|to|by)\s+(.+?)(?:\s|$|,|\.|;|in|for|instead)/i);
  if (match) {
    const oldVal = (match[3] || '').trim(); // Group 3 is the old value
    const newVal = (match[6] || '').trim(); // Group 6 is the new value
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 3: "remove X and put Y instead" or "remove X and replace with Y"
  match = msg.match(/\b(remove|delete)\s+(the\s+)?(value\s+)?(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+and\s+(put|replace|add|use|set)\s+(.+?)(?:\s+instead|\s+in\s+place|$|,|\.|;)/i);
  if (match) {
    const oldVal = (match[4] || '').trim();
    const newVal = (match[7] || '').trim();
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 4: "remove X and put Y instead" (simpler, no "the value")
  // Group 1: verb, Group 2: quote (optional), Group 3: old value, Group 4: quote (optional), Group 5: "put/replace/add/use/set", Group 6: new value
  match = msg.match(/\b(remove|delete)\s+(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+and\s+(put|replace|add|use|set)\s+(.+?)(?:\s+instead|\s+in\s+place|$|,|\.|;)/i);
  if (match) {
    const oldVal = (match[3] || '').trim(); // Group 3 is the old value
    const newVal = (match[6] || '').trim(); // Group 6 is the new value
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 5: "change X to Y" or "convert X to Y"
  match = msg.match(/\b(change|convert|transform)\s+(the\s+)?(value\s+)?(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+to\s+(.+?)(?:\s|$|,|\.|;)/i);
  if (match) {
    const oldVal = (match[4] || '').trim();
    const newVal = (match[6] || '').trim();
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 6: "substitute X for Y" (note: "for" means replace X with Y)
  match = msg.match(/\b(substitute|replace)\s+(the\s+)?(value\s+)?(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s+for\s+(.+?)(?:\s|$|,|\.|;)/i);
  if (match) {
    const oldVal = (match[4] || '').trim();
    const newVal = (match[6] || '').trim();
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  // Pattern 7: "remove X, use Y" or "remove X, put Y"
  match = msg.match(/\b(remove|delete)\s+(the\s+)?(value\s+)?(['"]?)(-|N\/A|NA|n\/a|na|empty|null|blank)(['"]?)\s*[,;]\s*(use|put|replace|add|set)\s+(.+?)(?:\s|$|,|\.|;)/i);
  if (match) {
    const oldVal = (match[4] || '').trim();
    const newVal = (match[7] || '').trim();
    if (oldVal && newVal) {
      return { oldValue: normalizeOldValue(oldVal), newValue: normalizeNewValue(newVal), column: findMentionedColumn(msg, availableColumns) };
    }
  }

  return null;
}
