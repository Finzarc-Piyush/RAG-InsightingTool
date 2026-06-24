/**
 * W62 · Analysis Memory page — durable per-session timeline rendered from the
 * Cosmos `analysis_memory` container (W56). Lists every analytical event
 * (questions, hypotheses, findings, charts, computed columns, filters,
 * dashboards, data ops, user notes, conclusions) grouped by turn, with type
 * filters, semantic search, and Markdown / JSON export.
 *
 * The page is the user-visible side of "everything in sync, persisting
 * forever" — the same entries that feed the planner's recall block (W60)
 * are surfaced here so the user can see exactly what the agent remembers.
 *
 * Reorientation (managerial-first): the default view shows Decisions &
 * findings (question, finding, conclusion, dashboard saves/edits, user
 * notes). Working notes (hypotheses, charts, filters, computed columns,
 * data ops, draft-only dashboards, lifecycle markers) live behind a toggle.
 * Each card renders the type-specific `body` payload — TL;DR / findings /
 * next steps for conclusions, full filter values, full note text, computed
 * column definitions, data-op deltas, etc. Turn-group headers surface the
 * conclusion's TL;DR so the answer reads above the working steps.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { analysisMemoryApi } from "@/lib/api";
import type {
  AnalysisMemoryEntry,
  AnalysisMemoryEntryType,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BookOpen,
  Search,
  Filter,
  Download,
  Loader2,
  Sparkles,
  HelpCircle,
  TrendingUp,
  BarChart3,
  Layers,
  Filter as FilterIcon,
  Wrench,
  StickyNote,
  CheckCircle2,
  FileBarChart,
  FileText,
  FileSpreadsheet,
  Calendar,
  Table2,
  ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TYPE_META: Record<
  AnalysisMemoryEntryType,
  { label: string; Icon: typeof BookOpen; tone: string }
> = {
  analysis_created: {
    label: "Created",
    Icon: FileSpreadsheet,
    tone: "text-muted-foreground",
  },
  enrichment_complete: {
    label: "Profiled",
    Icon: Sparkles,
    tone: "text-muted-foreground",
  },
  question_asked: {
    label: "Question",
    Icon: HelpCircle,
    tone: "text-primary",
  },
  hypothesis: {
    label: "Hypothesis",
    Icon: TrendingUp,
    tone: "text-foreground",
  },
  finding: { label: "Finding", Icon: Layers, tone: "text-foreground" },
  chart_created: {
    label: "Chart",
    Icon: BarChart3,
    tone: "text-foreground",
  },
  computed_column_added: {
    label: "Computed column",
    Icon: Wrench,
    tone: "text-muted-foreground",
  },
  filter_applied: {
    label: "Filter",
    Icon: FilterIcon,
    tone: "text-muted-foreground",
  },
  data_op: {
    label: "Data op",
    Icon: Wrench,
    tone: "text-muted-foreground",
  },
  dashboard_drafted: {
    label: "Dashboard draft",
    Icon: FileBarChart,
    tone: "text-muted-foreground",
  },
  dashboard_promoted: {
    label: "Dashboard saved",
    Icon: FileBarChart,
    tone: "text-primary",
  },
  dashboard_patched: {
    label: "Dashboard edited",
    Icon: FileBarChart,
    tone: "text-foreground",
  },
  user_note: {
    label: "Note",
    Icon: StickyNote,
    tone: "text-muted-foreground",
  },
  conclusion: {
    label: "Conclusion",
    Icon: CheckCircle2,
    tone: "text-primary",
  },
  // AMR7 · Aggregated pivot result emitted by an `execute_query_plan` step.
  pivot_computed: {
    label: "Pivot computed",
    Icon: Table2,
    tone: "text-foreground",
  },
  // AMR7 · Compact rollup of the answer envelope (tldr + implications +
  // recommendations) for the in-session journal. Distinct from `conclusion`
  // (which mirrors the verifier-pass envelope verbatim); `answer_summary` is
  // the AnalysisMemory-page-friendly projection.
  answer_summary: {
    label: "Answer summary",
    Icon: ScrollText,
    tone: "text-primary",
  },
};

const ALL_TYPES: AnalysisMemoryEntryType[] = [
  "question_asked",
  "hypothesis",
  "finding",
  "chart_created",
  "pivot_computed",
  "computed_column_added",
  "filter_applied",
  "data_op",
  "dashboard_drafted",
  "dashboard_promoted",
  "dashboard_patched",
  "user_note",
  "conclusion",
  "answer_summary",
  "analysis_created",
  "enrichment_complete",
];

// Managerial-first taxonomy: the things a non-technical decision-maker came
// to look at vs the working steps that produced them.
const DECISION_TYPES: readonly AnalysisMemoryEntryType[] = [
  "question_asked",
  "finding",
  "conclusion",
  "answer_summary",
  "dashboard_promoted",
  "dashboard_patched",
  "user_note",
];

const WORKING_NOTE_TYPES: readonly AnalysisMemoryEntryType[] = [
  "hypothesis",
  "chart_created",
  "pivot_computed",
  "filter_applied",
  "computed_column_added",
  "data_op",
  "dashboard_drafted",
  "analysis_created",
  "enrichment_complete",
];

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v : asString(v)))
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

interface ConclusionFinding {
  headline: string;
  evidence?: string;
  magnitude?: string;
}

function asConclusionFindings(value: unknown): ConclusionFinding[] {
  if (!Array.isArray(value)) return [];
  const out: ConclusionFinding[] = [];
  for (const f of value) {
    if (!f || typeof f !== "object") continue;
    const headline = asString((f as Record<string, unknown>).headline);
    if (!headline) continue;
    out.push({
      headline,
      evidence: asString((f as Record<string, unknown>).evidence),
      magnitude: asString((f as Record<string, unknown>).magnitude),
    });
  }
  return out;
}

function getConclusionTldr(entry: AnalysisMemoryEntry | undefined): string | undefined {
  if (!entry || entry.type !== "conclusion") return undefined;
  return asString((entry.body as Record<string, unknown> | undefined)?.tldr);
}

interface TurnGroup {
  turnId: string | null;
  question: string;
  conclusionTldr?: string;
  startedAt: number;
  entries: AnalysisMemoryEntry[];
}

function groupByTurn(entries: AnalysisMemoryEntry[]): TurnGroup[] {
  const buckets = new Map<string, AnalysisMemoryEntry[]>();
  for (const e of entries) {
    const key = e.turnId ?? "__lifecycle__";
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries())
    .map(([key, group]) => {
      const isLifecycle = key === "__lifecycle__";
      const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
      const conclusion = sorted.find((e) => e.type === "conclusion");
      const question =
        sorted.find((e) => e.type === "question_asked")?.title ??
        (isLifecycle ? "Lifecycle events" : "(no question)");

      // Reorder: conclusion first, then findings, then everything else by
      // createdAt. This puts the answer above the working notes so a manager
      // skimming the page reads the takeaway first. Lifecycle stays
      // chronological — there's no "answer" to pin.
      const ordered = isLifecycle
        ? sorted
        : [
            ...(conclusion ? [conclusion] : []),
            ...sorted.filter((e) => e.type === "finding"),
            ...sorted.filter(
              (e) => e.type !== "conclusion" && e.type !== "finding"
            ),
          ];

      return {
        turnId: isLifecycle ? null : key,
        question,
        conclusionTldr: getConclusionTldr(conclusion),
        startedAt: sorted[0]?.createdAt ?? 0,
        entries: ordered,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

// -- per-type body renderers (all driven by already-persisted `entry.body`) --

function ConclusionBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const tldr = asString(body.tldr);
  const findings = asConclusionFindings(body.findings);
  const nextSteps = asStringArray(body.nextSteps);
  const caveats = asStringArray(body.caveats);
  const methodology = asString(body.methodology);

  const hasStructured =
    tldr || findings.length > 0 || nextSteps.length > 0 || caveats.length > 0 || methodology;

  // If the body never populated (older entries, edge cases), fall back to
  // the existing summary so we degrade gracefully instead of going blank.
  if (!hasStructured) {
    return entry.summary && entry.summary !== entry.title ? (
      <p className="mt-1 text-sm text-muted-foreground break-words whitespace-pre-wrap">
        {entry.summary}
      </p>
    ) : null;
  }

  return (
    <div className="mt-2 space-y-3">
      {tldr ? (
        <p className="text-sm text-foreground break-words whitespace-pre-wrap">
          {tldr}
        </p>
      ) : null}

      {findings.length > 0 ? (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
            Findings
          </p>
          <ul className="list-disc pl-5 space-y-1.5 text-sm text-foreground">
            {findings.map((f, i) => (
              <li key={i} className="break-words">
                <span className="font-medium">{f.headline}</span>
                {f.magnitude ? (
                  <span className="ml-2 inline-block rounded-full bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 align-middle uppercase tracking-wide">
                    {f.magnitude}
                  </span>
                ) : null}
                {f.evidence ? (
                  <p className="mt-0.5 text-xs text-muted-foreground break-words whitespace-pre-wrap">
                    {f.evidence}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {nextSteps.length > 0 ? (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1">
            Next steps
          </p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-foreground">
            {nextSteps.map((s, i) => (
              <li key={i} className="break-words">
                {s}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {caveats.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Caveats ({caveats.length})
          </summary>
          <ul className="mt-1 list-disc pl-5 space-y-1 text-xs text-muted-foreground">
            {caveats.map((c, i) => (
              <li key={i} className="break-words">
                {c}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {methodology ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Methodology
          </summary>
          <p className="mt-1 text-xs text-muted-foreground break-words whitespace-pre-wrap">
            {methodology}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function UserNoteBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const noteText = asString((entry.body as Record<string, unknown> | undefined)?.noteText);
  if (!noteText) {
    return entry.summary && entry.summary !== entry.title ? (
      <p className="mt-1 text-sm text-muted-foreground break-words whitespace-pre-wrap">
        {entry.summary}
      </p>
    ) : null;
  }
  return (
    <p className="mt-1 text-sm text-foreground break-words whitespace-pre-wrap">
      {noteText}
    </p>
  );
}

function FilterBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const column = asString(body.column);
  const op = asString(body.op);
  const match = asString(body.match);
  const values = asStringArray(body.values);
  if (!column || values.length === 0) {
    return entry.summary && entry.summary !== entry.title ? (
      <p className="mt-1 text-sm text-muted-foreground break-words">
        {entry.summary}
      </p>
    ) : null;
  }
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        {values.length} value{values.length === 1 ? "" : "s"} · {op ?? "in"}
        {match ? ` · ${match}` : ""}
      </summary>
      <p className="mt-1 text-xs text-muted-foreground break-words">
        {column} <span className="text-muted-foreground/70">{op ?? "in"}</span>{" "}
        {values.join(", ")}
      </p>
    </details>
  );
}

function ChartBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const chartType = asString(body.chartType);
  const x = asString(body.x);
  const y = asString(body.y);
  const aggregate = asString(body.aggregate);
  const seriesColumn = asString(body.seriesColumn);
  // AMR7 · richer body — the per-chart insight survives into the journal, so
  // the AnalysisMemory page reads as the narrator's voice over the original
  // chart rather than just axis identifiers.
  const keyInsight = asString(body.keyInsight);
  const config = [
    chartType,
    y && x ? `${y} by ${x}` : y || x,
    aggregate ? `agg ${aggregate}` : null,
    seriesColumn ? `series ${seriesColumn}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      {keyInsight ? (
        <p className="mt-1 text-sm text-foreground break-words whitespace-pre-wrap">
          {keyInsight}
        </p>
      ) : entry.summary && entry.summary !== entry.title ? (
        <p className="mt-1 text-sm text-foreground break-words whitespace-pre-wrap">
          {entry.summary}
        </p>
      ) : null}
      {config ? (
        <p className="mt-1 text-xs text-muted-foreground break-words">{config}</p>
      ) : null}
    </>
  );
}

interface PivotArtifactRef {
  artifactId: string;
  storage: { kind: "inline" | "blob"; blobName?: string; bytes?: number };
}

function PivotBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const ref = body.artifactRef as PivotArtifactRef | undefined;
  const rowCount = asNumber(body.rowCount);
  const columnHeaders = asStringArray(body.columnHeaders);
  const pivotDefaults = body.pivotDefaults as
    | { rows?: string[]; values?: string[]; columns?: string[] }
    | undefined;
  const dimensionsLine = [
    pivotDefaults?.rows?.length
      ? `Rows: ${pivotDefaults.rows.join(", ")}`
      : null,
    pivotDefaults?.values?.length
      ? `Values: ${pivotDefaults.values.join(", ")}`
      : null,
    pivotDefaults?.columns?.length
      ? `Columns: ${pivotDefaults.columns.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="mt-1 space-y-1">
      {entry.summary && entry.summary !== entry.title ? (
        <p className="text-sm text-foreground break-words whitespace-pre-wrap">
          {entry.summary}
        </p>
      ) : null}
      {dimensionsLine ? (
        <p className="text-xs text-muted-foreground break-words">
          {dimensionsLine}
        </p>
      ) : null}
      {rowCount !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"}
          {columnHeaders.length > 0 ? ` across ${columnHeaders.length} field${columnHeaders.length === 1 ? "" : "s"}` : ""}
          {ref ? ` · storage: ${ref.storage.kind}` : ""}
        </p>
      ) : null}
      {ref ? (
        <p className="text-[11px] text-muted-foreground/80 break-all">
          Artifact: <span className="font-mono">{ref.artifactId.slice(0, 12)}…</span>
        </p>
      ) : null}
    </div>
  );
}

function AnswerSummaryBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const tldr = asString(body.tldr);
  const implications = asStringArray(body.implications);
  const recommendations = asStringArray(body.recommendations);
  return (
    <div className="mt-1 space-y-2">
      {tldr ? (
        <p className="text-sm font-medium text-foreground break-words whitespace-pre-wrap">
          {tldr}
        </p>
      ) : entry.summary && entry.summary !== entry.title ? (
        <p className="text-sm text-foreground break-words whitespace-pre-wrap">
          {entry.summary}
        </p>
      ) : null}
      {implications.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Implications
          </p>
          <ul className="ml-4 list-disc text-xs text-muted-foreground space-y-0.5">
            {implications.map((i, idx) => (
              <li key={idx} className="break-words">
                {i}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {recommendations.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Recommendations
          </p>
          <ul className="ml-4 list-disc text-xs text-muted-foreground space-y-0.5">
            {recommendations.map((r, idx) => (
              <li key={idx} className="break-words">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ComputedColumnBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const description = asString(body.description);
  const persistedToBlob = body.persistedToBlob === true;
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const columnNames = columns
    .map((c) => (c && typeof c === "object" ? asString((c as Record<string, unknown>).name) : undefined))
    .filter((n): n is string => typeof n === "string");

  return (
    <div className="mt-1 space-y-1">
      {description ? (
        <p className="text-sm text-foreground break-words whitespace-pre-wrap">
          {description}
        </p>
      ) : null}
      {columnNames.length > 0 ? (
        <p className="text-xs text-muted-foreground break-words">
          Columns: {columnNames.join(", ")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {persistedToBlob
          ? "Persisted as a new dataset version."
          : "In-memory for this turn only."}
      </p>
    </div>
  );
}

function DataOpBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const operation = asString(body.operation);
  const description = asString(body.description);
  const rowsBefore = asNumber(body.rowsBefore);
  const rowsAfter = asNumber(body.rowsAfter);
  return (
    <div className="mt-1 space-y-1">
      {description ? (
        <p className="text-sm text-foreground break-words">{description}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {operation ? `Operation: ${operation}` : null}
        {operation && rowsBefore !== undefined && rowsAfter !== undefined ? " · " : null}
        {rowsBefore !== undefined && rowsAfter !== undefined
          ? `${rowsBefore.toLocaleString()} → ${rowsAfter.toLocaleString()} rows`
          : null}
      </p>
    </div>
  );
}

function DashboardSavedBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const sheetCount = asNumber(body.sheetCount);
  const chartCount = asNumber(body.chartCount);
  const parts: string[] = [];
  if (sheetCount !== undefined) parts.push(`${sheetCount} sheet${sheetCount === 1 ? "" : "s"}`);
  if (chartCount !== undefined) parts.push(`${chartCount} chart${chartCount === 1 ? "" : "s"}`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">{parts.join(" · ")}</p>
  );
}

function DashboardPatchedBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const added = asNumber(body.addedCount);
  const removed = asNumber(body.removedCount);
  const renamedTo = asString(body.renamedSheetTo);
  const ops: string[] = [];
  if (added && added > 0) ops.push(`added ${added} chart${added === 1 ? "" : "s"}`);
  if (removed && removed > 0) ops.push(`removed ${removed} chart${removed === 1 ? "" : "s"}`);
  if (renamedTo) ops.push(`renamed sheet to "${renamedTo}"`);
  if (ops.length === 0) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{ops.join("; ")}</p>;
}

function DashboardDraftBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const sheetCount = asNumber((entry.body as Record<string, unknown> | undefined)?.sheetCount);
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {sheetCount !== undefined
        ? `${sheetCount} sheet${sheetCount === 1 ? "" : "s"} — not yet saved.`
        : "Not yet saved."}
    </p>
  );
}

function AnalysisCreatedBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const fileName = asString(body.fileName);
  const fileSize = asNumber(body.fileSize);
  if (!fileName) return null;
  const sizeMb =
    fileSize !== undefined ? `${(fileSize / (1024 * 1024)).toFixed(2)} MB` : null;
  return (
    <p className="mt-1 text-xs text-muted-foreground break-words">
      {fileName}
      {sizeMb ? ` · ${sizeMb}` : ""}
    </p>
  );
}

function EnrichmentCompleteBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const rowCount = asNumber(body.rowCount);
  const columnCount = asNumber(body.columnCount);
  const suggested = asStringArray(body.suggestedQuestions).slice(0, 3);
  return (
    <div className="mt-1 space-y-1">
      {rowCount !== undefined && columnCount !== undefined ? (
        <p className="text-xs text-muted-foreground">
          {rowCount.toLocaleString()} rows × {columnCount} columns
        </p>
      ) : null}
      {suggested.length > 0 ? (
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
            Starter prompts
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {suggested.map((q, i) => (
              <li key={i} className="break-words">
                {q}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function HypothesisBody({ entry }: { entry: AnalysisMemoryEntry }) {
  const body = (entry.body ?? {}) as Record<string, unknown>;
  const status = asString(body.status);
  const evidenceCount = asNumber(body.evidenceCount);
  if (!status && evidenceCount === undefined) {
    return entry.summary && entry.summary !== entry.title ? (
      <p className="mt-1 text-sm text-muted-foreground break-words">
        {entry.summary}
      </p>
    ) : null;
  }
  const tone =
    status === "supported"
      ? "bg-primary/10 text-primary"
      : status === "contradicted"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {status ? (
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wide",
            tone
          )}
        >
          {status}
        </span>
      ) : null}
      {evidenceCount !== undefined && evidenceCount > 0 ? (
        <span className="text-xs text-muted-foreground">
          {evidenceCount} evidence point{evidenceCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </div>
  );
}

function FindingBody({ entry }: { entry: AnalysisMemoryEntry }) {
  // Finding's headline already lives in `summary` (which equals the label
  // from investigationSummary.findings). Significance is rendered as the
  // pill in the shared header. No further body rendering needed.
  return entry.summary && entry.summary !== entry.title ? (
    <p className="mt-1 text-sm text-foreground break-words whitespace-pre-wrap">
      {entry.summary}
    </p>
  ) : null;
}

function GenericSummary({ entry }: { entry: AnalysisMemoryEntry }) {
  return entry.summary && entry.summary !== entry.title ? (
    <p className="mt-1 text-sm text-muted-foreground break-words whitespace-pre-wrap">
      {entry.summary}
    </p>
  ) : null;
}

function EntryBody({ entry }: { entry: AnalysisMemoryEntry }) {
  switch (entry.type) {
    case "conclusion":
      return <ConclusionBody entry={entry} />;
    case "user_note":
      return <UserNoteBody entry={entry} />;
    case "filter_applied":
      return <FilterBody entry={entry} />;
    case "chart_created":
      return <ChartBody entry={entry} />;
    case "pivot_computed":
      return <PivotBody entry={entry} />;
    case "answer_summary":
      return <AnswerSummaryBody entry={entry} />;
    case "computed_column_added":
      return <ComputedColumnBody entry={entry} />;
    case "data_op":
      return <DataOpBody entry={entry} />;
    case "dashboard_promoted":
      return <DashboardSavedBody entry={entry} />;
    case "dashboard_patched":
      return <DashboardPatchedBody entry={entry} />;
    case "dashboard_drafted":
      return <DashboardDraftBody entry={entry} />;
    case "analysis_created":
      return <AnalysisCreatedBody entry={entry} />;
    case "enrichment_complete":
      return <EnrichmentCompleteBody entry={entry} />;
    case "hypothesis":
      return <HypothesisBody entry={entry} />;
    case "finding":
      return <FindingBody entry={entry} />;
    case "question_asked":
      return null; // title-only entry by design
    default:
      return <GenericSummary entry={entry} />;
  }
}

function EntryCard({ entry }: { entry: AnalysisMemoryEntry }) {
  const meta = TYPE_META[entry.type];
  const Icon = meta.Icon;
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", meta.tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              {meta.label}
            </span>
            {entry.significance && entry.significance !== "routine" ? (
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full uppercase tracking-wide",
                  entry.significance === "anomalous"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-primary/10 text-primary"
                )}
              >
                {entry.significance}
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {formatTimestamp(entry.createdAt)}
            </span>
          </div>
          <p className="mt-1 text-sm font-medium text-foreground break-words">
            {entry.title}
          </p>
          <EntryBody entry={entry} />
          {entry.refs?.dashboardId ? (
            <a
              href={`/dashboard?open=${encodeURIComponent(entry.refs.dashboardId)}`}
              className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <FileBarChart className="h-3 w-3" aria-hidden /> Open dashboard
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// -- search hit parser: chunks are emitted by the W57 indexer with leading
// "Type: …" / "Title: …" lines per memoryEntryBuilders / chunking. Parse
// gracefully and fall back to raw content if the shape doesn't match.
function parseSearchHit(content: string): {
  type?: AnalysisMemoryEntryType;
  title?: string;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  let type: AnalysisMemoryEntryType | undefined;
  let title: string | undefined;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z][\w]*)\s*:\s*(.*)$/.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "type") {
      if ((ALL_TYPES as readonly string[]).includes(value)) {
        type = value as AnalysisMemoryEntryType;
      }
      bodyStart = i + 1;
    } else if (key === "title") {
      title = value;
      bodyStart = i + 1;
    } else if (key === "summary" || key === "actor" || key === "significance") {
      bodyStart = i + 1;
    } else {
      break;
    }
  }
  const body = lines.slice(bodyStart).join("\n").trim();
  return { type, title, body };
}

function SearchHitCard({
  content,
  score,
}: {
  content: string;
  score: number | undefined;
}) {
  const { type, title, body } = parseSearchHit(content);
  const meta = type ? TYPE_META[type] : undefined;
  const Icon = meta?.Icon;
  if (!meta || !Icon) {
    // Fallback: raw rendering matches the prior behaviour for non-canonical
    // chunks (e.g. legacy entries indexed before the canonical shape).
    return (
      <div className="rounded-md border border-border bg-card p-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          score {typeof score === "number" ? score.toFixed(3) : "—"}
        </p>
        <p className="text-sm text-foreground whitespace-pre-wrap">{content}</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-2">
        <Icon className={cn("h-4 w-4 mt-0.5 shrink-0", meta.tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              {meta.label}
            </span>
            <span className="text-[10px] text-muted-foreground">
              score {typeof score === "number" ? score.toFixed(3) : "—"}
            </span>
          </div>
          {title ? (
            <p className="mt-1 text-sm font-medium text-foreground break-words">
              {title}
            </p>
          ) : null}
          {body ? (
            <p className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap break-words">
              {body}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function AnalysisMemory() {
  const [match, params] = useRoute<{ sessionId: string }>(
    "/analysis/:sessionId/memory"
  );
  const sessionId = match ? params?.sessionId : null;

  // Default: Decisions on, Working notes off — the managerial view.
  const [showDecisions, setShowDecisions] = useState(true);
  const [showWorkingNotes, setShowWorkingNotes] = useState(false);
  const [activeTypes, setActiveTypes] = useState<Set<AnalysisMemoryEntryType>>(
    () => new Set(DECISION_TYPES)
  );
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const listQuery = useQuery({
    queryKey: [
      "analysisMemory",
      sessionId,
      "list",
      Array.from(activeTypes).sort().join(","),
    ],
    queryFn: () =>
      analysisMemoryApi.list(sessionId!, {
        types: activeTypes.size > 0 ? Array.from(activeTypes) : undefined,
        limit: 500,
      }),
    enabled: Boolean(sessionId),
  });

  const searchResultQuery = useQuery({
    queryKey: ["analysisMemory", sessionId, "search", searchQuery],
    queryFn: () => analysisMemoryApi.search(sessionId!, searchQuery, 12),
    enabled: Boolean(sessionId) && searchQuery.length > 0,
  });

  const grouped = useMemo(() => {
    const entries = listQuery.data?.entries ?? [];
    return groupByTurn(entries);
  }, [listQuery.data]);

  const totalEntries = listQuery.data?.entries.length ?? 0;
  const filterIsActive = activeTypes.size > 0 && activeTypes.size < ALL_TYPES.length;

  if (!sessionId) {
    return (
      <div className="p-8">
        <p className="text-sm text-muted-foreground">
          No session selected. Open a session from the Analysis history to view
          its memory.
        </p>
      </div>
    );
  }

  const toggleType = (t: AnalysisMemoryEntryType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  // Tier toggles operate on the underlying type set so the existing query
  // path doesn't need to know about tiers. Toggling Decisions adds/removes
  // the decision types as a group; same for Working notes.
  const setTier = (
    tier: "decisions" | "workingNotes",
    enabled: boolean
  ) => {
    const types = tier === "decisions" ? DECISION_TYPES : WORKING_NOTE_TYPES;
    setActiveTypes((prev) => {
      const next = new Set(prev);
      for (const t of types) {
        if (enabled) next.add(t);
        else next.delete(t);
      }
      return next;
    });
    if (tier === "decisions") setShowDecisions(enabled);
    else setShowWorkingNotes(enabled);
  };

  const clearFilters = () => {
    setActiveTypes(new Set(DECISION_TYPES));
    setShowDecisions(true);
    setShowWorkingNotes(false);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <BookOpen className="h-5 w-5 text-primary" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">
              Analysis Memory
            </h1>
            <p className="text-sm text-muted-foreground">
              Decisions, findings, dashboards, and notes from this analysis.
              Toggle Working notes to see the underlying steps. Persists
              across sessions; feeds the agent on every future turn.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[260px]">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setSearchQuery(searchInput.trim());
              }}
              placeholder="Search memory semantically (press Enter)"
              className="pl-9"
            />
          </div>
          {searchQuery ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchInput("");
                setSearchQuery("");
              }}
            >
              Clear search
            </Button>
          ) : null}
          <a
            href={analysisMemoryApi.exportUrl(sessionId, "markdown")}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex"
          >
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" aria-hidden />
              <FileText className="h-4 w-4 mr-1" aria-hidden /> Markdown
            </Button>
          </a>
          <a
            href={analysisMemoryApi.exportUrl(sessionId, "json")}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex"
          >
            <Button variant="outline" size="sm">
              <Download className="h-4 w-4 mr-1" aria-hidden /> JSON
            </Button>
          </a>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1 mr-1">
            <Filter className="h-3.5 w-3.5" aria-hidden /> Show:
          </span>
          <button
            type="button"
            onClick={() => setTier("decisions", !showDecisions)}
            className={cn(
              "text-xs rounded-full border px-2.5 py-0.5 transition-colors",
              showDecisions
                ? "bg-primary/10 border-primary text-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            )}
          >
            Decisions &amp; findings
          </button>
          <button
            type="button"
            onClick={() => setTier("workingNotes", !showWorkingNotes)}
            className={cn(
              "text-xs rounded-full border px-2.5 py-0.5 transition-colors",
              showWorkingNotes
                ? "bg-primary/10 border-primary text-primary"
                : "border-border text-muted-foreground hover:bg-muted"
            )}
          >
            Working notes
          </button>
          {filterIsActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              reset
            </button>
          ) : null}
        </div>

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            Show by individual type
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ALL_TYPES.map((t) => {
              const meta = TYPE_META[t];
              const active = activeTypes.has(t);
              return (
                <button
                  type="button"
                  key={t}
                  onClick={() => toggleType(t)}
                  className={cn(
                    "text-xs rounded-full border px-2.5 py-0.5 transition-colors",
                    active
                      ? "bg-primary/10 border-primary text-primary"
                      : "border-border text-muted-foreground hover:bg-muted"
                  )}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </details>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        {searchQuery ? (
          <section className="mb-6">
            <h2 className="text-sm font-medium text-foreground mb-2">
              Semantic search results for{" "}
              <span className="text-muted-foreground">"{searchQuery}"</span>
            </h2>
            {searchResultQuery.isPending ? (
              <p className="text-sm text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{" "}
                Searching…
              </p>
            ) : searchResultQuery.data?.hits?.length ? (
              <div className="space-y-2">
                {searchResultQuery.data.hits.map((h) => (
                  <SearchHitCard
                    key={h.chunkId}
                    content={h.content}
                    score={typeof h.score === "number" ? h.score : undefined}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No matches.{" "}
                {searchResultQuery.data?.retrievalError ? (
                  <span>(Retrieval error — Memory may not be indexed yet.)</span>
                ) : null}
              </p>
            )}
          </section>
        ) : null}

        {listQuery.isPending ? (
          <p className="text-sm text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading
            memory…
          </p>
        ) : totalEntries === 0 ? (
          activeTypes.size === 0 || !filterIsActive ? (
            <p className="text-sm text-muted-foreground">
              No memory entries yet — they appear automatically as you ask
              questions, build charts, save dashboards, and add notes.
            </p>
          ) : (
            <div className="rounded-md border border-border bg-card/40 p-4">
              <p className="text-sm text-muted-foreground">
                No entries match the current filter.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                className="mt-2"
              >
                Reset to Decisions &amp; findings
              </Button>
            </div>
          )
        ) : (
          <div className="space-y-6">
            {grouped.map((g) => (
              <section
                key={g.turnId ?? "lifecycle"}
                className="rounded-lg border border-border bg-card/40 p-4"
              >
                <header className="mb-3">
                  <h3 className="text-sm font-semibold text-foreground line-clamp-2">
                    {g.question}
                  </h3>
                  {g.conclusionTldr ? (
                    <p className="mt-0.5 text-sm text-muted-foreground break-words line-clamp-3">
                      {g.conclusionTldr}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground inline-flex items-center gap-1">
                    <Calendar className="h-3 w-3" aria-hidden />
                    {formatTimestamp(g.startedAt)}
                    <span className="mx-1">·</span>
                    {g.entries.length} entr
                    {g.entries.length === 1 ? "y" : "ies"}
                  </p>
                </header>
                <div className="space-y-2">
                  {g.entries.map((e) => (
                    <EntryCard key={e.id} entry={e} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
