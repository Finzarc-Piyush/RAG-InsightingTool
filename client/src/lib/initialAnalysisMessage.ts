import type {
  DataSummary,
  DatasetProfile,
  Message,
  SessionAnalysisContext,
} from '@/shared/schema';

export function isInitialAnalysisMessage(msg: Message): boolean {
  if (msg.role !== 'assistant') return false;

  const content = msg.content?.toLowerCase() || '';
  if (content.includes('initial analysis for')) return true;
  if (content.includes("i've loaded your dataset")) return true;
  if (content.includes("i've just finished analyzing") || content.includes('just finished analyzing')) return true;
  if (/\d+\s+rows\s*·\s*\d+\s+columns/.test(content)) return true;
  if (msg.suggestedQuestions && msg.suggestedQuestions.length > 0) return true;
  if (msg.charts && msg.charts.length > 0) return true;
  if (msg.insights && msg.insights.length > 0) return true;
  return false;
}

/** Stats + optional LLM dataset line — no hardcoded prompt copy. */
export function buildSyntheticInitialAssistantContent(
  ds: DataSummary,
  opts?: { sessionAnalysisContext?: SessionAnalysisContext; datasetProfile?: DatasetProfile }
): string {
  const lines = [
    `${ds.rowCount} rows · ${ds.columnCount} columns`,
    `${ds.numericColumns.length} numeric columns`,
    `${ds.dateColumns.length} date columns`,
  ];
  const desc =
    opts?.sessionAnalysisContext?.dataset?.shortDescription?.trim() ||
    opts?.datasetProfile?.shortDescription?.trim();
  if (desc) lines.push('', desc);
  return lines.join('\n');
}

export function suggestedFollowUpsFromSession(opts?: {
  sessionAnalysisContext?: SessionAnalysisContext;
  datasetProfile?: DatasetProfile;
}): string[] | undefined {
  const fromSac = opts?.sessionAnalysisContext?.suggestedFollowUps;
  if (fromSac?.length) return fromSac;
  const fromProf = opts?.datasetProfile?.suggestedQuestions;
  if (fromProf?.length) return fromProf;
  return undefined;
}
