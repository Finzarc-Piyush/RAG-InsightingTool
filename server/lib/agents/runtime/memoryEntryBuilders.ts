/**
 * W58 · Pure mapper — given a completed turn's persisted artifacts, produce
 * the array of `AnalysisMemoryEntry` documents for the W56 container and the
 * W57 RAG mirror. No side effects: caller owns Cosmos write + AI Search index.
 *
 * One pure builder per entry type (`question_asked`, `hypothesis`, `finding`,
 * `chart_created`, `filter_applied`, `dashboard_drafted`, `conclusion`) keeps
 * the file scannable and unit-testable.
 */
import type {
  AnalysisMemoryEntry,
  ChartSpec,
  InvestigationSummary,
  Message,
} from "../../../shared/schema.js";
import { buildMemoryEntryId } from "../../../models/analysisMemory.model.js";

export interface TurnEndContext {
  sessionId: string;
  username: string;
  turnId: string;
  /** Underlying data version this turn ran against; for staleness checks. */
  dataVersion: number;
  /** ms epoch — single timestamp for the entire turn so ordering is stable. */
  createdAt: number;
  /** Original user question text. */
  question: string;
  /** The persisted assistant message (charts, envelope, applied filters, etc.). */
  assistant: Message;
  /** Investigation summary, when produced by the agent. */
  investigationSummary?: InvestigationSummary;
  /** Applied filters captured during the turn. */
  appliedFilters?: Array<{
    column: string;
    op: "in" | "not_in";
    values: string[];
    match?: "exact" | "case_insensitive" | "contains";
  }>;
}

const TITLE_MAX = 200;
const SUMMARY_MAX = 1500;

function clip(s: string | undefined, max: number): string {
  const trimmed = (s ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function clipNonEmpty(s: string | undefined, max: number, fallback: string): string {
  const c = clip(s, max);
  return c || fallback;
}

function buildQuestionEntry(ctx: TurnEndContext): AnalysisMemoryEntry {
  const title = clipNonEmpty(ctx.question, TITLE_MAX, "(untitled question)");
  return {
    id: buildMemoryEntryId(ctx.sessionId, "question_asked", 0, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt,
    turnId: ctx.turnId,
    sequence: 0,
    type: "question_asked",
    actor: "user",
    title,
    summary: title,
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  };
}

function buildHypothesisEntries(ctx: TurnEndContext): AnalysisMemoryEntry[] {
  const hyps = ctx.investigationSummary?.hypotheses ?? [];
  return hyps.map((h, i) => ({
    id: buildMemoryEntryId(ctx.sessionId, "hypothesis", i, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt + i,
    turnId: ctx.turnId,
    sequence: i,
    type: "hypothesis",
    actor: "agent",
    title: clipNonEmpty(h.text, TITLE_MAX, `Hypothesis #${i + 1}`),
    summary: clipNonEmpty(
      `${h.text} — status: ${h.status}${h.evidenceCount ? ` (${h.evidenceCount} evidence)` : ""}`,
      SUMMARY_MAX,
      h.text
    ),
    body: { status: h.status, evidenceCount: h.evidenceCount },
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  }));
}

function buildFindingEntries(ctx: TurnEndContext): AnalysisMemoryEntry[] {
  const findings = ctx.investigationSummary?.findings ?? [];
  return findings.map((f, i) => ({
    id: buildMemoryEntryId(ctx.sessionId, "finding", i, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt + i,
    turnId: ctx.turnId,
    sequence: i,
    type: "finding",
    actor: "agent",
    title: clipNonEmpty(f.label, TITLE_MAX, `Finding #${i + 1}`),
    summary: clipNonEmpty(f.label, SUMMARY_MAX, `Finding #${i + 1}`),
    body: { significance: f.significance },
    significance: f.significance,
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  }));
}

function chartTitle(c: ChartSpec, idx: number): string {
  if (c.title) return c.title;
  if (c.x && c.y) return `${c.type}: ${c.y} by ${c.x}`;
  return `${c.type} chart #${idx + 1}`;
}

function buildChartEntries(ctx: TurnEndContext): AnalysisMemoryEntry[] {
  const charts = ctx.assistant.charts ?? [];
  return charts.map((c, i) => ({
    id: buildMemoryEntryId(ctx.sessionId, "chart_created", i, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt + i,
    turnId: ctx.turnId,
    sequence: i,
    type: "chart_created",
    actor: "agent",
    title: clip(chartTitle(c, i), TITLE_MAX),
    summary: clipNonEmpty(
      c.keyInsight || c.businessCommentary || chartTitle(c, i),
      SUMMARY_MAX,
      chartTitle(c, i)
    ),
    body: {
      chartType: c.type,
      x: c.x,
      y: c.y,
      seriesColumn: c.seriesColumn,
      aggregate: c.aggregate,
    },
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  }));
}

function buildFilterEntries(ctx: TurnEndContext): AnalysisMemoryEntry[] {
  const filters = ctx.appliedFilters ?? [];
  return filters.map((f, i) => {
    const valuesPreview = f.values.slice(0, 6).join(", ");
    const more = f.values.length > 6 ? ` (+${f.values.length - 6} more)` : "";
    const title = clip(
      `Filter ${f.column} ${f.op} [${valuesPreview}${more}]`,
      TITLE_MAX
    );
    return {
      id: buildMemoryEntryId(ctx.sessionId, "filter_applied", i, ctx.turnId),
      sessionId: ctx.sessionId,
      username: ctx.username,
      createdAt: ctx.createdAt + i,
      turnId: ctx.turnId,
      sequence: i,
      type: "filter_applied",
      actor: "agent",
      title,
      summary: title,
      body: { column: f.column, op: f.op, values: f.values, match: f.match },
      dataVersion: ctx.dataVersion,
      refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
    };
  });
}

function buildDashboardDraftEntry(
  ctx: TurnEndContext
): AnalysisMemoryEntry | null {
  const draft = ctx.assistant.dashboardDraft as
    | { name?: string; sheets?: unknown[] }
    | undefined;
  if (!draft) return null;
  const name = (draft.name as string | undefined) || "Dashboard draft";
  const sheets = Array.isArray(draft.sheets) ? draft.sheets.length : 0;
  return {
    id: buildMemoryEntryId(ctx.sessionId, "dashboard_drafted", 0, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt,
    turnId: ctx.turnId,
    sequence: 0,
    type: "dashboard_drafted",
    actor: "agent",
    title: clip(`Dashboard draft: ${name}`, TITLE_MAX),
    summary: clip(
      `Agent proposed a dashboard "${name}" with ${sheets} sheet(s). User has not yet promoted it.`,
      SUMMARY_MAX
    ),
    body: { name, sheetCount: sheets },
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  };
}

function buildConclusionEntry(ctx: TurnEndContext): AnalysisMemoryEntry | null {
  const env = ctx.assistant.answerEnvelope;
  const tldr = env?.tldr;
  const recommendations = env?.nextSteps ?? [];
  const findings = env?.findings ?? [];
  const fallbackSummary = (() => {
    if (tldr) return tldr;
    if (findings.length > 0) {
      return findings.map((f) => f.headline).join(" • ");
    }
    return clip(ctx.assistant.content || "", SUMMARY_MAX);
  })();
  if (!tldr && findings.length === 0 && !ctx.assistant.content) return null;
  const title = clipNonEmpty(
    tldr || ctx.question || "Turn conclusion",
    TITLE_MAX,
    "Turn conclusion"
  );
  const summary = clip(
    [
      tldr && `TL;DR: ${tldr}`,
      findings.length > 0 &&
        `Findings: ${findings.map((f) => f.headline).join("; ")}`,
      recommendations.length > 0 &&
        `Next steps: ${recommendations.join("; ")}`,
    ]
      .filter(Boolean)
      .join("\n") || fallbackSummary,
    SUMMARY_MAX
  );
  return {
    id: buildMemoryEntryId(ctx.sessionId, "conclusion", 0, ctx.turnId),
    sessionId: ctx.sessionId,
    username: ctx.username,
    createdAt: ctx.createdAt,
    turnId: ctx.turnId,
    sequence: 0,
    type: "conclusion",
    actor: "agent",
    title,
    summary,
    body: {
      tldr,
      findings,
      caveats: env?.caveats,
      nextSteps: recommendations,
      methodology: env?.methodology,
    },
    dataVersion: ctx.dataVersion,
    refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
  };
}

/**
 * Build the full set of entries for a completed turn. Empty arrays / nulls
 * are filtered out so callers always get a clean list to upsert.
 */
export function buildTurnEndMemoryEntries(
  ctx: TurnEndContext
): AnalysisMemoryEntry[] {
  const entries: AnalysisMemoryEntry[] = [];
  entries.push(buildQuestionEntry(ctx));
  entries.push(...buildHypothesisEntries(ctx));
  entries.push(...buildFindingEntries(ctx));
  entries.push(...buildChartEntries(ctx));
  entries.push(...buildFilterEntries(ctx));
  const draft = buildDashboardDraftEntry(ctx);
  if (draft) entries.push(draft);
  const conclusion = buildConclusionEntry(ctx);
  if (conclusion) entries.push(conclusion);
  return entries;
}
