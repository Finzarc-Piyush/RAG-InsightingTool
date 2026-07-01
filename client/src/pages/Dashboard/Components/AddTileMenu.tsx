import { useEffect, useState } from "react";
import {
  BarChart3,
  LayoutGrid,
  Loader2,
  Minus,
  Plus,
  Search,
  StickyNote,
  Table2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";
import { sessionsApi } from "@/lib/api/sessions";
import type { ChartSpec, DashboardTableSpec } from "@/shared/schema";
import { chartSpecToTableSpec } from "../lib/chartSpecToTableSpec";
import { GuidedCardBuilderDialog } from "./GuidedCardBuilder/GuidedCardBuilderDialog";
import { cn } from "@/lib/utils";

/** Wave W12 · build-time Vite flag + optional localStorage override (dev/QA). */
function isCardBuilderOn(): boolean {
  try {
    const ls =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("dashboard.cardBuilder")
        : null;
    if (ls === "true") return true;
    if (ls === "false") return false;
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_DASHBOARD_CARD_BUILDER === "true";
}

/**
 * Wave DR6 · "+ Add tile" menu, mounted above the canvas. Visible only
 * when the user holds edit permission AND has edit-mode toggled on
 * (the menu is meaningless in view mode).
 *
 * Initial scope:
 *   - Markdown note   — opens an editor modal; adds a narrative block
 *                       with role: "custom"
 *   - Divider/spacer  — adds a narrative block with body "---" so the
 *                       canvas can be visually grouped
 *
 * Both items go through the existing
 * `PATCH /api/dashboards/:id/sheets/:sheetId/content` plumbing the
 * caller wires up via `onAddNarrative`. Chart-from-session is a
 * follow-up wave (it needs cross-session chart browsing UI).
 */

interface AddTileMenuProps {
  onAddNarrative: (block: {
    id: string;
    role: "custom";
    title: string;
    body: string;
    order: number;
  }) => Promise<void>;
  /**
   * DR13 · add a chart cloned from another session to the current
   * dashboard. Optional — when undefined the menu item is hidden.
   */
  onAddChart?: (chart: ChartSpec) => Promise<void>;
  /**
   * WD-add · add a TABLE derived from a session chart's data — the chart's
   * underlying rows become a standalone table tile. Optional — when
   * undefined the "Table from session" menu item is hidden.
   */
  onAddTable?: (table: DashboardTableSpec) => Promise<void>;
  /** Position the new block at this `order` value (default: prepend). */
  defaultOrder?: number;
  /** Wave W12 · guided card builder wiring (data-bound cards). */
  dashboardId?: string;
  sheetId?: string;
  /** True when the dashboard has an accessible source session to query. */
  hasSourceSession?: boolean;
  /** Called after a card is composed + persisted (refetch the dashboard). */
  onComposed?: () => void | Promise<void>;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AddTileMenu({
  onAddNarrative,
  onAddChart,
  onAddTable,
  defaultOrder = 0,
  dashboardId,
  sheetId,
  hasSourceSession,
  onComposed,
}: AddTileMenuProps) {
  const { mode, canToggle } = useDashboardEditMode();
  const [noteOpen, setNoteOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const showBuilder = isCardBuilderOn() && !!dashboardId && !!hasSourceSession;
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [chartPickerOpen, setChartPickerOpen] = useState(false);
  // WD-add · the session picker serves both "Chart from session" and
  // "Table from session"; `pickerKind` decides what a pick becomes.
  const [pickerKind, setPickerKind] = useState<"chart" | "table">("chart");

  if (!(canToggle && mode === "edit")) return null;

  const handleAddNote = async () => {
    if (!noteTitle.trim() || !noteBody.trim() || busy) return;
    setBusy(true);
    try {
      await onAddNarrative({
        id: generateId("note"),
        role: "custom",
        title: noteTitle.trim(),
        body: noteBody.trim(),
        order: defaultOrder,
      });
      setNoteOpen(false);
      setNoteTitle("");
      setNoteBody("");
    } finally {
      setBusy(false);
    }
  };

  const handleAddDivider = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onAddNarrative({
        id: generateId("divider"),
        role: "custom",
        title: "Divider",
        body: "---",
        order: defaultOrder,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Add tile
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {/* Wave W12 · DATA cards are selection-only (no typed numbers). */}
          <DropdownMenuLabel>Data</DropdownMenuLabel>
          {showBuilder ? (
            <DropdownMenuItem onSelect={() => setBuilderOpen(true)}>
              <LayoutGrid className="h-4 w-4 mr-2" />
              Build a card…
            </DropdownMenuItem>
          ) : null}
          {onAddChart ? (
            <DropdownMenuItem
              onSelect={() => {
                setPickerKind("chart");
                setChartPickerOpen(true);
              }}
            >
              <BarChart3 className="h-4 w-4 mr-2" />
              Chart from session
            </DropdownMenuItem>
          ) : null}
          {onAddTable ? (
            <DropdownMenuItem
              onSelect={() => {
                setPickerKind("table");
                setChartPickerOpen(true);
              }}
            >
              <Table2 className="h-4 w-4 mr-2" />
              Table from session
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Annotate</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setNoteOpen(true)}>
            <StickyNote className="h-4 w-4 mr-2" />
            Note (text)
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleAddDivider} disabled={busy}>
            <Minus className="h-4 w-4 mr-2" />
            Divider
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showBuilder && dashboardId ? (
        <GuidedCardBuilderDialog
          dashboardId={dashboardId}
          sheetId={sheetId}
          open={builderOpen}
          onOpenChange={setBuilderOpen}
          onComposed={async () => {
            await onComposed?.();
          }}
        />
      ) : null}

      {onAddChart || onAddTable ? (
        <ChartFromSessionPicker
          open={chartPickerOpen}
          kind={pickerKind}
          onOpenChange={setChartPickerOpen}
          onPick={async (chart) => {
            setBusy(true);
            try {
              if (pickerKind === "table") {
                const table = chartSpecToTableSpec(chart);
                // The picker only surfaces charts with derivable rows in table
                // mode, so `table` is normally non-null. If a degenerate chart
                // slips through, leave the picker open rather than silently
                // closing with nothing added.
                if (!table) return;
                await onAddTable?.(table);
              } else {
                await onAddChart?.(chart);
              }
              setChartPickerOpen(false);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Add markdown note</DialogTitle>
            <DialogDescription>
              Notes are persisted with the sheet and rendered as markdown.
              Use them for context, captions, or section headers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <label htmlFor="note-title" className="text-sm font-medium text-foreground">
                Title
              </label>
              <Input
                id="note-title"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Section header"
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="note-body" className="text-sm font-medium text-foreground">
                Body (markdown)
              </label>
              <Textarea
                id="note-body"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Write a note in markdown..."
                rows={8}
                disabled={busy}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={handleAddNote}
              disabled={!noteTitle.trim() || !noteBody.trim() || busy}
            >
              {busy ? "Adding…" : "Add note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Wave DR13 · session+chart picker for "Add chart from session".
 *
 * Two-step flow inside one modal:
 *   1. choose a session from the user's recent uploads
 *   2. choose a chart from that session's top-level chart cache
 *
 * The session details endpoint already enriches charts with their data
 * arrays (loaded from blob storage when needed), so the picked chart
 * arrives ready to embed via `dashboardsApi.addChart`. No re-fetching
 * happens at view time on the dashboard side.
 */

interface SessionListItem {
  id: string;
  fileName?: string | null;
  lastUpdatedAt?: string | null;
  uploadedAt?: string | null;
  chartCount?: number;
  sessionId?: string | null;
}

function ChartFromSessionPicker({
  open,
  kind = "chart",
  onOpenChange,
  onPick,
}: {
  open: boolean;
  /** WD-add · "table" mode adds the picked chart's data as a table tile and
   *  only surfaces charts that carry embedded rows. */
  kind?: "chart" | "table";
  onOpenChange: (next: boolean) => void;
  onPick: (chart: ChartSpec) => Promise<void>;
}) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pickedSessionId, setPickedSessionId] = useState<string | null>(null);
  const [charts, setCharts] = useState<ChartSpec[]>([]);
  const [chartsLoading, setChartsLoading] = useState(false);
  const [chartsError, setChartsError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Load session list when the modal opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsError(null);
    sessionsApi
      .getAllSessions()
      .then((res: any) => {
        if (cancelled) return;
        const list: SessionListItem[] = Array.isArray(res?.sessions) ? res.sessions : [];
        setSessions(list);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setSessionsError(e?.message || "Could not load sessions");
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Load that session's charts when one is picked.
  useEffect(() => {
    if (!pickedSessionId) return;
    let cancelled = false;
    setChartsLoading(true);
    setChartsError(null);
    setCharts([]);
    sessionsApi
      .getSessionDetails(pickedSessionId)
      .then((res: any) => {
        if (cancelled) return;
        // The endpoint hydrates charts onto messages — collect them, dedupe
        // by (type, title) so the same chart referenced in multiple messages
        // doesn't show up twice.
        const seen = new Set<string>();
        const collected: ChartSpec[] = [];
        const tryPush = (c: any) => {
          if (!c || !c.type || !c.title) return;
          const key = `${c.type}::${c.title}`;
          if (seen.has(key)) return;
          seen.add(key);
          collected.push(c as ChartSpec);
        };
        for (const c of res?.charts ?? []) tryPush(c);
        for (const m of res?.messages ?? []) {
          for (const c of m?.charts ?? []) tryPush(c);
        }
        setCharts(collected);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setChartsError(e?.message || "Could not load charts for this session");
      })
      .finally(() => {
        if (!cancelled) setChartsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pickedSessionId]);

  // Reset state when the modal closes so the user starts fresh next open.
  useEffect(() => {
    if (open) return;
    setPickedSessionId(null);
    setCharts([]);
    setQuery("");
  }, [open]);

  const trimmed = query.trim().toLowerCase();
  const visibleSessions = trimmed
    ? sessions.filter((s) => (s.fileName ?? "").toLowerCase().includes(trimmed))
    : sessions;

  // WD-add · in table mode only charts that carry embedded rows can become a
  // table, so hide the data-less ones (agent charts whose rows weren't shipped).
  const displayCharts =
    kind === "table"
      ? charts.filter((c) => {
          const data = (c as { data?: unknown }).data;
          // Mirror chartSpecToTableSpec's null condition: a derivable table
          // needs at least one keyed object row, else it has zero columns.
          return (
            Array.isArray(data) &&
            data.some(
              (r) => r && typeof r === "object" && Object.keys(r).length > 0,
            )
          );
        })
      : charts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>
            {kind === "table"
              ? "Add table from a session"
              : "Add chart from a session"}
          </DialogTitle>
          <DialogDescription>
            {kind === "table"
              ? "Pick a chat session, then pick a chart to add its underlying data as a table on the active sheet. The data is captured at the time it's added — edits in the source session won't affect the dashboard."
              : "Pick a chat session, then pick a chart to copy onto the active sheet. The chart's data is captured at the time it's added — edits in the source session won't affect the dashboard."}
          </DialogDescription>
        </DialogHeader>
        {pickedSessionId ? (
          <div className="space-y-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPickedSessionId(null)}
            >
              ← Back to sessions
            </Button>
            {chartsLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading charts…
              </div>
            ) : chartsError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {chartsError}
              </div>
            ) : displayCharts.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                {kind === "table"
                  ? "No charts with data to add as a table in this session."
                  : "No charts in this session yet."}
              </div>
            ) : (
              <ul className="max-h-[360px] overflow-y-auto space-y-1">
                {displayCharts.map((c, i) => (
                  <li key={`${c.type}::${c.title}::${i}`}>
                    <button
                      type="button"
                      disabled={adding}
                      onClick={async () => {
                        setAdding(true);
                        try {
                          await onPick(c);
                        } finally {
                          setAdding(false);
                        }
                      }}
                      className={cn(
                        "w-full flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm transition-colors",
                        "hover:bg-muted/50 disabled:opacity-50 disabled:cursor-progress",
                      )}
                    >
                      {kind === "table" ? (
                        <Table2 className="h-4 w-4 text-primary flex-shrink-0" />
                      ) : (
                        <BarChart3 className="h-4 w-4 text-primary flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {c.title}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {c.type} · {c.x ?? ""}
                          {c.y ? ` × ${c.y}` : ""}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by file name…"
                className="pl-8"
              />
            </div>
            {sessionsLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading sessions…
              </div>
            ) : sessionsError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {sessionsError}
              </div>
            ) : visibleSessions.length === 0 ? (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                {sessions.length === 0
                  ? "You don't have any sessions yet."
                  : "No sessions match that name."}
              </div>
            ) : (
              <ul className="max-h-[360px] overflow-y-auto space-y-1">
                {visibleSessions.map((s) => {
                  const id = s.sessionId || s.id;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => setPickedSessionId(id)}
                        className="w-full flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground truncate">
                            {s.fileName ?? "Untitled session"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {(s.chartCount ?? 0)} chart
                            {(s.chartCount ?? 0) === 1 ? "" : "s"}
                            {s.lastUpdatedAt
                              ? ` · updated ${new Date(s.lastUpdatedAt).toLocaleDateString()}`
                              : ""}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
