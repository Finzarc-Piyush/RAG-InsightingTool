import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type { Layouts } from "react-grid-layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Eyebrow, Heading } from "@/components/ui/typography";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
  AttentionAreaSpec,
  DashboardAnswerEnvelope,
  DashboardScorecardSpec,
} from "@/shared/schema";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";
import {
  DashboardScorecardRow,
  isScorecardExecSummaryOn,
} from "./DashboardScorecardRow";
import {
  SUMMARY_GROUPS,
  SUMMARY_GROUP_ORDER,
  summaryGroupItems,
  addSummaryItem,
  editSummaryItem,
  deleteSummaryItem,
  ensureSummaryIds,
  blankSummaryValues,
  summaryItemToValues,
  type SummaryGroupKey,
  type SummaryPatch,
} from "../lib/summaryBandEdit";
import { hasSummaryBandContent } from "../lib/summaryBandData";
import { SummaryItemDialog } from "./SummaryItemDialog";
import { DashboardSummaryGrid } from "./DashboardSummaryGrid";

/**
 * Wave ES1 · the Executive-Summary band — the dashboard's self-explanatory
 * first view.
 *
 * W-SBGRID · the band's six card groups (Key numbers, Attention areas, Key
 * findings, "Why it might be happening", "Why it matters", Priority actions) are
 * rendered as ONE free-form react-grid-layout canvas (`DashboardSummaryGrid`):
 * in edit mode every card drags + resizes and its position persists per
 * dashboard; view mode shows the same arrangement, inert. Add a card from the
 * "Add ▾" menu; hover a card for edit/delete. Earlier waves (C3/C4) rendered six
 * fixed CSS-grid sections — those are gone; cards now self-identify by content.
 */

const STORAGE_PREFIX = "dashboard-summary-band-open:";

function readOpen(dashboardId: string): boolean {
  if (typeof sessionStorage === "undefined") return true;
  try {
    return sessionStorage.getItem(`${STORAGE_PREFIX}${dashboardId}`) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(dashboardId: string, open: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${dashboardId}`, open ? "1" : "0");
  } catch {
    /* quota / private mode — ignore */
  }
}

export interface DashboardSummaryBandProps {
  dashboardId: string;
  envelope?: DashboardAnswerEnvelope;
  /** MW4 · below-org-average units to surface as an "Attention areas" callout
   *  (management-by-exception). Sourced from the DashboardSpec, not the envelope. */
  attentionAreas?: AttentionAreaSpec[];
  /** MW4/MW6 · click a problem area to filter/drill into it. */
  onAttentionAreaClick?: (area: AttentionAreaSpec) => void;
  /** Opens the full analysis-summary drawer for the deep detail. */
  onOpenSummary?: () => void;
  /** Wave C2 · persist an edit to the band (whole-field PATCH). When omitted
   *  the band stays read-only even in edit mode (e.g. a viewer surface). */
  onUpdate?: (patch: SummaryPatch) => void;
  /** W-SBGRID · saved free-form card positions (dashboard.summaryGridLayout). */
  summaryGridLayout?: Layouts | null;
  /** W-SBGRID · debounced persist of the card layout on drag/resize. */
  onPersistSummaryLayout?: (layouts: Layouts) => void;
  /** Wave W7 · data-bound KPI scorecards (dashboard.scorecards). Rendered as a
   *  strip above the narrative; gated by VITE_SCORECARD_EXEC_SUMMARY. */
  scorecards?: DashboardScorecardSpec[] | null;
  /** Wave W8 · re-run the KPI scorecards against the current dataset (edit mode). */
  onRecomputeScorecards?: () => void | Promise<void>;
}

export function DashboardSummaryBand({
  dashboardId,
  envelope,
  attentionAreas,
  onAttentionAreaClick,
  onOpenSummary,
  onUpdate,
  summaryGridLayout,
  onPersistSummaryLayout,
  scorecards,
  onRecomputeScorecards,
}: DashboardSummaryBandProps) {
  const [open, setOpen] = useState<boolean>(() => readOpen(dashboardId));
  useEffect(() => setOpen(readOpen(dashboardId)), [dashboardId]);
  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      writeOpen(dashboardId, next);
      return next;
    });
  }, [dashboardId]);

  const { canToggle, mode } = useDashboardEditMode();
  const isEditing = !!onUpdate && canToggle && mode === "edit";

  // W-SBGRID · once, on entering edit mode, backfill stable ids onto legacy /
  // synthesizer-produced cards so the free-form grid's saved positions survive a
  // sibling delete. We attempt this AT MOST ONCE per dashboard (a ref guard):
  // that keeps it edit-only (a viewer never writes) AND can't loop even if a
  // round-trip somehow returned id-less cards.
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isEditing || !onUpdate) return;
    if (hydratedRef.current === dashboardId) return;
    const hasContent = hasSummaryBandContent(envelope) || (attentionAreas?.length ?? 0) > 0;
    if (!hasContent) return; // wait until the band actually has cards
    hydratedRef.current = dashboardId;
    const { changed, patch } = ensureSummaryIds(envelope, attentionAreas);
    if (changed) onUpdate(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing, dashboardId, envelope, attentionAreas]);

  const [editor, setEditor] = useState<{
    group: SummaryGroupKey;
    mode: "add" | "edit";
    index: number;
  } | null>(null);

  const openAdd = (group: SummaryGroupKey) =>
    setEditor({ group, mode: "add", index: -1 });
  const openEdit = (group: SummaryGroupKey, index: number) =>
    setEditor({ group, mode: "edit", index });
  const handleDelete = (group: SummaryGroupKey, index: number) =>
    onUpdate?.(deleteSummaryItem(group, index, envelope, attentionAreas));
  const handleSave = (values: Record<string, string>) => {
    if (!editor) return;
    const patch =
      editor.mode === "add"
        ? addSummaryItem(editor.group, values, envelope, attentionAreas)
        : editSummaryItem(editor.group, editor.index, values, envelope, attentionAreas);
    onUpdate?.(patch);
    setEditor(null);
  };

  const tldr =
    typeof envelope?.tldr === "string" && envelope.tldr.trim()
      ? envelope.tldr.trim()
      : null;
  const hasScorecards = (scorecards?.length ?? 0) > 0;
  const hasAnything =
    hasSummaryBandContent(envelope) ||
    (attentionAreas?.length ?? 0) > 0 ||
    hasScorecards;

  if (!hasAnything && !isEditing) return null;

  const editorGroup = editor ? SUMMARY_GROUPS[editor.group] : null;
  const editorInitialValues = (() => {
    if (!editor) return {};
    if (editor.mode === "add") return blankSummaryValues(editor.group);
    const items = summaryGroupItems(editor.group, envelope, attentionAreas);
    const item = items[editor.index];
    return item ? summaryItemToValues(editor.group, item) : blankSummaryValues(editor.group);
  })();

  const handleAttentionAreaClick = (index: number) => {
    const area = attentionAreas?.[index];
    if (area) onAttentionAreaClick?.(area);
  };

  return (
    <Card className="mb-4 overflow-hidden border-border/60">
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5 lg:px-5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`dashboard-summary-band-${dashboardId}`}
          className="group flex items-center gap-2 rounded-brand-sm text-left transition-colors hover:opacity-90"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          )}
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          <Eyebrow>Executive summary</Eyebrow>
          {!open && tldr ? (
            <span className="ml-1 truncate text-sm text-muted-foreground max-w-[40vw]">
              {tldr}
            </span>
          ) : null}
        </button>
        <div className="flex items-center gap-1">
          {/* Wave W8 · refresh the data-bound KPI scorecards against current data. */}
          {isEditing && onRecomputeScorecards && hasScorecards && isScorecardExecSummaryOn() ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void onRecomputeScorecards()}
              className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground"
              title="Recompute the KPI scorecards from the latest data"
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Refresh KPIs
            </Button>
          ) : null}
          {/* W-SBGRID · reset the free-form arrangement back to auto-placement. */}
          {isEditing && onPersistSummaryLayout && summaryGridLayout
            && Object.keys(summaryGridLayout).length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onPersistSummaryLayout({})}
              className="h-7 flex-shrink-0 px-2 text-xs text-muted-foreground"
              title="Reset card positions to the default arrangement"
            >
              Reset layout
            </Button>
          ) : null}
          {/* W-SBGRID · one "Add ▾" entry point replaces the six per-section
              "Add" buttons now that the band is a single free-form canvas. */}
          {isEditing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 flex-shrink-0 px-2 text-xs"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Add
                  <ChevronDown className="ml-1 h-3 w-3" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SUMMARY_GROUP_ORDER
                  // Wave W8 · when the data-bound scorecard band is active, the
                  // free-typed "Key number" add path is removed — KPI numbers
                  // must come from real dataset queries, never typed by hand.
                  .filter((group) => !(group === "magnitudes" && isScorecardExecSummaryOn()))
                  .map((group) => (
                    <DropdownMenuItem key={group} onClick={() => openAdd(group)} className="capitalize">
                      {SUMMARY_GROUPS[group].singular}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {onOpenSummary ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenSummary}
              className="h-7 flex-shrink-0 px-2 text-xs text-primary hover:text-primary"
            >
              Full summary
              <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div id={`dashboard-summary-band-${dashboardId}`} className="px-4 pb-4 lg:px-5">
          {/* Wave W7 · data-bound KPI scorecards lead the exec summary. */}
          <DashboardScorecardRow scorecards={scorecards} />

          {tldr ? (
            <Heading size="md" as="p" className="mt-3 max-w-4xl text-foreground/90">
              {tldr}
            </Heading>
          ) : null}

          <DashboardSummaryGrid
            envelope={envelope}
            attentionAreas={attentionAreas}
            isEditing={isEditing}
            serverLayout={summaryGridLayout}
            onPersistLayout={onPersistSummaryLayout}
            onEditCard={openEdit}
            onDeleteCard={handleDelete}
            onAttentionAreaClick={onAttentionAreaClick ? handleAttentionAreaClick : undefined}
          />

          {isEditing && !hasAnything ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No summary cards yet. Use <span className="font-medium">Add</span> to create one.
            </p>
          ) : null}
        </div>
      ) : null}

      {editor && editorGroup ? (
        <SummaryItemDialog
          open
          mode={editor.mode}
          group={editorGroup}
          initialValues={editorInitialValues}
          onSave={handleSave}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </Card>
  );
}
