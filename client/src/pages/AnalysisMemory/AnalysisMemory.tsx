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
};

const ALL_TYPES: AnalysisMemoryEntryType[] = [
  "question_asked",
  "hypothesis",
  "finding",
  "chart_created",
  "computed_column_added",
  "filter_applied",
  "data_op",
  "dashboard_drafted",
  "dashboard_promoted",
  "dashboard_patched",
  "user_note",
  "conclusion",
  "analysis_created",
  "enrichment_complete",
];

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function groupByTurn(entries: AnalysisMemoryEntry[]): Array<{
  turnId: string | null;
  question: string;
  startedAt: number;
  entries: AnalysisMemoryEntry[];
}> {
  const buckets = new Map<string, AnalysisMemoryEntry[]>();
  for (const e of entries) {
    const key = e.turnId ?? "__lifecycle__";
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }
  return Array.from(buckets.entries())
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => a.createdAt - b.createdAt);
      const question =
        sorted.find((e) => e.type === "question_asked")?.title ??
        (key === "__lifecycle__" ? "Lifecycle events" : "(no question)");
      return {
        turnId: key === "__lifecycle__" ? null : key,
        question,
        startedAt: sorted[0]?.createdAt ?? 0,
        entries: sorted,
      };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
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
          {entry.summary && entry.summary !== entry.title ? (
            <p className="mt-1 text-sm text-muted-foreground break-words">
              {entry.summary}
            </p>
          ) : null}
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

export default function AnalysisMemory() {
  const [match, params] = useRoute<{ sessionId: string }>(
    "/analysis/:sessionId/memory"
  );
  const sessionId = match ? params?.sessionId : null;

  const [activeTypes, setActiveTypes] = useState<Set<AnalysisMemoryEntryType>>(
    new Set()
  );
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const listQuery = useQuery({
    queryKey: ["analysisMemory", sessionId, "list", Array.from(activeTypes).sort().join(",")],
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
              Durable timeline of every question, hypothesis, finding, chart,
              filter, computed column, dashboard, and conclusion in this
              analysis. Persists across sessions; feeds the agent on every
              future turn.
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

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1 mr-1">
            <Filter className="h-3.5 w-3.5" aria-hidden /> Types:
          </span>
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
          {activeTypes.size > 0 ? (
            <button
              type="button"
              onClick={() => setActiveTypes(new Set())}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              clear
            </button>
          ) : null}
        </div>
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
                  <div
                    key={h.chunkId}
                    className="rounded-md border border-border bg-card p-3"
                  >
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      score{" "}
                      {typeof h.score === "number"
                        ? h.score.toFixed(3)
                        : "—"}
                    </p>
                    <p className="text-sm text-foreground whitespace-pre-wrap">
                      {h.content}
                    </p>
                  </div>
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
          <p className="text-sm text-muted-foreground">
            No memory entries yet — they appear automatically as you ask
            questions, build charts, save dashboards, and add notes.
          </p>
        ) : (
          <div className="space-y-6">
            {grouped.map((g) => (
              <section
                key={g.turnId ?? "lifecycle"}
                className="rounded-lg border border-border bg-card/40 p-4"
              >
                <header className="mb-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-foreground line-clamp-2">
                      {g.question}
                    </h3>
                    <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" aria-hidden />
                      {formatTimestamp(g.startedAt)}
                      <span className="mx-1">·</span>
                      {g.entries.length} entr
                      {g.entries.length === 1 ? "y" : "ies"}
                    </p>
                  </div>
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
