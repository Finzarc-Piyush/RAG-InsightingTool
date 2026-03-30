/**
 * Column Extractor
 * Uses RegEx ONLY to extract column names from chat messages
 * This is the ONLY place RegEx should be used for column extraction
 */

type SpanHit = { column: string; start: number; end: number };

/**
 * @ColumnName tokens from the composer (mention picker / sidebar insert). Longest match first
 * so @Sales (Volume) % Chg YA matches before @Sales (Volume).
 */
function extractAtMentionColumns(message: string, availableColumns: string[]): string[] {
  const sorted = [...availableColumns].sort((a, b) => b.length - a.length);
  const found: string[] = [];
  for (const col of sorted) {
    const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('@' + escaped + '(?=\\s|$|[,;:!?.])', 'i');
    if (re.test(message)) {
      found.push(col);
    }
  }
  return found;
}

function spanLen(s: SpanHit): number {
  return s.end - s.start;
}

/**
 * Drop hits whose span lies entirely inside another hit's span (e.g. "Volume" inside "Sales (Volume)").
 * Longer spans win; ties keep both unless identical span (same column deduped later).
 */
function dropSpansContainedInLonger(hits: SpanHit[]): SpanHit[] {
  if (hits.length <= 1) {
    return hits;
  }
  const sorted = [...hits].sort((a, b) => spanLen(b) - spanLen(a));
  const kept: SpanHit[] = [];
  for (const h of sorted) {
    const insideKept = kept.some(
      (k) => h.start >= k.start && h.end <= k.end && spanLen(k) >= spanLen(h)
    );
    if (!insideKept) {
      kept.push(h);
    }
  }
  return kept;
}

function uniqueColumnsByFirstAppearance(hits: SpanHit[]): string[] {
  hits.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (!seen.has(h.column)) {
      seen.add(h.column);
      out.push(h.column);
    }
  }
  return out;
}

function collectQuotedHits(message: string, columnMap: Map<string, string>): SpanHit[] {
  const hits: SpanHit[] = [];
  const quotedPattern = /["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = quotedPattern.exec(message)) !== null) {
    const rawInner = match[1];
    const trimmed = rawInner.trim();
    const normalized = trimmed.toLowerCase();
    if (!columnMap.has(normalized)) {
      continue;
    }
    const column = columnMap.get(normalized)!;
    const rel = rawInner.indexOf(trimmed);
    const start = match.index + 1 + (rel >= 0 ? rel : 0);
    const end = start + trimmed.length;
    hits.push({ column, start, end });
  }
  return hits;
}

function collectPhraseHits(message: string, col: string): SpanHit[] {
  const normalizedCol = col.toLowerCase().trim();
  const escapedCol = normalizedCol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrasePattern = new RegExp(`(?:^|[^\\w])${escapedCol}(?=[^\\w]|$)`, 'gi');
  const hits: SpanHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = phrasePattern.exec(message)) !== null) {
    hits.push({ column: col, start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

function collectFlexibleHits(message: string, col: string): SpanHit[] {
  const normalizedCol = col.toLowerCase().trim();
  if (!normalizedCol.includes(' ') && !normalizedCol.includes('_') && !normalizedCol.includes('-')) {
    return [];
  }
  const flexiblePattern = normalizedCol
    .replace(/\s+/g, '\\s+')
    .replace(/_/g, '[\\s_]+')
    .replace(/-/g, '[\\s-]+');
  const escapedPattern = flexiblePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phrasePattern = new RegExp(escapedPattern, 'gi');
  const hits: SpanHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = phrasePattern.exec(message)) !== null) {
    hits.push({ column: col, start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

/**
 * Extracts column names from a chat message using RegEx patterns
 * Matches against available columns from the dataset
 *
 * @param message - The chat message to extract columns from
 * @param availableColumns - Array of available column names from the dataset
 * @returns Array of extracted column names that match available columns
 */
export function extractColumnsFromMessage(
  message: string,
  availableColumns: string[]
): string[] {
  if (!message || !availableColumns || availableColumns.length === 0) {
    return [];
  }

  const columnMap = new Map<string, string>();
  for (const col of availableColumns) {
    const normalized = col.toLowerCase().trim();
    columnMap.set(normalized, col);
  }

  const atMentionColumns = extractAtMentionColumns(message, availableColumns);
  if (atMentionColumns.length > 0) {
    return dedupeSubsumedColumnNames(atMentionColumns);
  }

  const allHits: SpanHit[] = [];
  allHits.push(...collectQuotedHits(message, columnMap));

  for (const col of availableColumns) {
    allHits.push(...collectPhraseHits(message, col));
  }

  for (const col of availableColumns) {
    allHits.push(...collectFlexibleHits(message, col));
  }

  const survived = dropSpansContainedInLonger(allHits);
  const extractedColumns = uniqueColumnsByFirstAppearance(survived);

  return dedupeSubsumedColumnNames(extractedColumns);
}

/**
 * If both "Sales" and "Sales (Volume)" match, keep only the more specific name.
 * Uses prefix checks so shorter tokens don't duplicate longer column matches.
 */
function dedupeSubsumedColumnNames(columns: string[]): string[] {
  if (columns.length <= 1) {
    return columns;
  }
  const sorted = [...columns].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  for (const c of sorted) {
    const lower = c.toLowerCase();
    const subsumedByLonger = out.some((o) => {
      if (o.length <= c.length) return false;
      const ol = o.toLowerCase();
      return ol.startsWith(lower + ' ') || ol.startsWith(lower + '(');
    });
    if (!subsumedByLonger) {
      out.push(c);
    }
  }
  return out;
}
