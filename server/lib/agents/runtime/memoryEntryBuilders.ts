/**
 * ============================================================================
 * memoryEntryBuilders.ts — turn the results of one finished chat turn into
 *                          saveable "memory" records
 * ============================================================================
 * WHAT THIS FILE DOES
 *   After the agent finishes answering a question, this file looks at everything
 *   that turn produced (the question, hypotheses tested, findings, charts, pivot
 *   tables, applied filters, dashboard drafts, the final conclusion) and turns
 *   each of those into a small structured record called an `AnalysisMemoryEntry`.
 *   These records form the app's "analysis memory": a browsable, searchable
 *   timeline of what was investigated. There is one small pure function per
 *   record type, which keeps the code easy to read and unit-test.
 *   "Pure" here means these functions only compute and return data — they do not
 *   write to any database. Writing the records to storage (Cosmos DB) and to the
 *   search index (Azure AI Search) is the caller's job.
 *
 * WHY IT MATTERS
 *   The analysis-memory feature lets users (and later turns) recall what was
 *   already discovered without re-running the analysis. This file is the single
 *   place that decides what gets remembered from each turn and how each record
 *   is shaped (title, summary, body, references). Without it, finished turns
 *   would leave no durable, searchable trace.
 *
 * KEY PIECES
 *   - TurnEndContext — input bag: everything a finished turn produced, plus ids
 *     (session, user, turn), the data version, and a single timestamp so all
 *     records from the turn sort in a stable order.
 *   - buildTurnEndMemoryEntries(ctx) — the only public entry point. Calls every
 *     per-type builder, drops empty results, and returns one clean list to save.
 *   - buildQuestionEntry / buildHypothesisEntries / buildFindingEntries /
 *     buildChartEntries / buildPivotEntries / buildFilterEntries /
 *     buildDashboardDraftEntry / buildConclusionEntry — one builder per record
 *     type; each maps a slice of the turn into `AnalysisMemoryEntry` records.
 *   - clip / clipNonEmpty — trim and length-cap text for titles/summaries.
 *
 * HOW IT CONNECTS
 *   Pulls `AnalysisMemoryEntry`, `ChartSpec`, etc. types from
 *   ../../../shared/schema.js, deterministic ids from
 *   ../../../models/analysisMemory.model.js, and pivot-artifact previews from
 *   ../../pastAnalysisPivotArtifact.js. Pivot rows themselves are NOT duplicated
 *   here — they live on the cross-session `past_analyses` doc, and each
 *   `pivot_computed` record just references them by a deterministic artifactId.
 */
import type {
  AnalysisMemoryEntry,
  ChartSpec,
  InvestigationSummary,
  Message,
} from "../../../shared/schema.js";
import { buildMemoryEntryId } from "../../../models/analysisMemory.model.js";
import {
  previewMaterializedArtifact,
  type RawPivotArtifact,
} from "../../pastAnalysisPivotArtifact.js";

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
  /**
   * Raw pivot captures from `execute_query_plan` steps. Each entry also flows
   * through `materializePivotArtifact` to be persisted on the cross-session
   * `past_analyses` doc. Here we emit one `pivot_computed` analysis_memory
   * entry per capture; the body references the deterministic `artifactId`
   * (sha256 of session|turn|step) so a client opening the entry can fetch rows
   * via the recall endpoint. Storage isn't duplicated — past_analyses owns the
   * rows.
   */
  pivotArtifacts?: RawPivotArtifact[];
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
  return charts.map((c, i) => {
    // Richer chart_created body: carry the per-chart insight + commentary and
    // a stripped-data chart spec so the AnalysisMemory page renders the
    // original narrative + a recreatable spec, not just axis identifiers.
    // `data` is excluded — heavy rows live in the past_analyses pivot artifact
    // / are reconstructible from the query.
    const { data: _data, ...specWithoutData } = c as ChartSpec & { data?: unknown };
    return {
      id: buildMemoryEntryId(ctx.sessionId, "chart_created", i, ctx.turnId),
      sessionId: ctx.sessionId,
      username: ctx.username,
      createdAt: ctx.createdAt + i,
      turnId: ctx.turnId,
      sequence: i,
      type: "chart_created" as const,
      actor: "agent" as const,
      title: clip(chartTitle(c, i), TITLE_MAX),
      summary: clipNonEmpty(
        c.keyInsight || chartTitle(c, i),
        SUMMARY_MAX,
        chartTitle(c, i)
      ),
      body: {
        chartType: c.type,
        x: c.x,
        y: c.y,
        seriesColumn: c.seriesColumn,
        aggregate: c.aggregate,
        ...(c.keyInsight ? { keyInsight: c.keyInsight } : {}),
        chartSpec: specWithoutData,
      },
      dataVersion: ctx.dataVersion,
      refs: { messageTimestamp: ctx.createdAt, dataVersion: ctx.dataVersion },
    };
  });
}

function buildPivotEntries(ctx: TurnEndContext): AnalysisMemoryEntry[] {
  const pivots = ctx.pivotArtifacts ?? [];
  return pivots.map((raw, i) => {
    const { artifactId, storageKind, bytes, blobName } =
      previewMaterializedArtifact(raw);
    const title = clipNonEmpty(
      raw.questionContext || `Pivot computed: ${raw.columnHeaders.join(" × ")}`,
      TITLE_MAX,
      `Pivot computed #${i + 1}`
    );
    const rowCount = raw.rows.length;
    const summary = clip(
      `${rowCount} row${rowCount === 1 ? "" : "s"} across [${raw.columnHeaders
        .slice(0, 8)
        .join(", ")}${raw.columnHeaders.length > 8 ? ", …" : ""}]${
        raw.questionContext ? ` — ${raw.questionContext}` : ""
      }`,
      SUMMARY_MAX
    );
    return {
      id: buildMemoryEntryId(ctx.sessionId, "pivot_computed", i, ctx.turnId),
      sessionId: ctx.sessionId,
      username: ctx.username,
      createdAt: ctx.createdAt + i,
      turnId: ctx.turnId,
      sequence: i,
      type: "pivot_computed" as const,
      actor: "agent" as const,
      title,
      summary,
      body: {
        artifactRef: {
          artifactId,
          storage:
            storageKind === "inline"
              ? { kind: "inline" as const, bytes }
              : { kind: "blob" as const, blobName, bytes },
        },
        plan: raw.plan,
        pivotDefaults: raw.pivotDefaults,
        columnHeaders: raw.columnHeaders,
        rowCount,
      },
      dataVersion: ctx.dataVersion,
      refs: {
        messageTimestamp: ctx.createdAt,
        dataVersion: ctx.dataVersion,
      },
    };
  });
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
  entries.push(...buildPivotEntries(ctx));
  entries.push(...buildFilterEntries(ctx));
  const draft = buildDashboardDraftEntry(ctx);
  if (draft) entries.push(draft);
  const conclusion = buildConclusionEntry(ctx);
  if (conclusion) entries.push(conclusion);
  return entries;
}
