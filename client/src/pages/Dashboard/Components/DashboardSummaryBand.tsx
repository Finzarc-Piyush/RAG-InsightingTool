import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Compass,
  HelpCircle,
  ListChecks,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Caption, Eyebrow, Heading, Metric } from "@/components/ui/typography";
import { cn } from "@/lib/utils";
import { MagnitudesRow } from "@/pages/Home/Components/MagnitudesRow";
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";
import { selectSummaryBandData, selectAttentionAreas } from "../lib/summaryBandData";
import { useDashboardEditMode } from "../context/DashboardEditModeContext";
import {
  SUMMARY_GROUPS,
  summaryGroupItems,
  addSummaryItem,
  editSummaryItem,
  deleteSummaryItem,
  blankSummaryValues,
  summaryItemToValues,
  type SummaryGroupKey,
  type SummaryPatch,
} from "../lib/summaryBandEdit";
import { SummaryItemDialog } from "./SummaryItemDialog";

/**
 * Wave ES1 · the Executive-Summary band — the dashboard's self-explanatory
 * first view.
 *
 * Wave C3/C4 · the band's six card groups (Key numbers, Attention areas, Key
 * findings, "Why it might be happening", "Why it matters", Priority actions)
 * are now EDITABLE in dashboard edit mode: each card gets hover edit/delete
 * controls and each section an "Add" button. Edits operate on the RAW,
 * uncapped envelope / attentionAreas arrays (so add/edit/delete map 1:1 to the
 * persisted items — the read-only view caps & sorts, which would misalign
 * indices), then persist via `onUpdate` (a whole-field PATCH). View mode is the
 * unchanged compact, curated presentation.
 */

const STORAGE_PREFIX = "dashboard-summary-band-open:";

/** IUX3 · horizon chip labels — mirrors the drawer's RecommendationsByHorizon. */
const HORIZON_LABEL: Record<"now" | "this_quarter" | "strategic", string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

// W-DX1 · the hedged causal lane on the dashboard band. Same labels + standing
// disclaimer as the chat AnswerCard so a CXO reads "why" identically everywhere.
const DRIVER_BASIS_LABEL: Record<"data" | "domain" | "general", string> = {
  data: "from the data",
  domain: "industry knowledge",
  general: "general knowledge",
};
const LIKELY_DRIVERS_DISCLAIMER =
  "Plausible explanations — hypotheses, not measured in this data unless marked “from the data”.";

function confidenceVariant(
  c: "low" | "medium" | "high" | undefined,
): "secondary" | "success" | "outline" {
  if (c === "high") return "success";
  if (c === "low") return "outline";
  return "secondary";
}

/** Collapse whitespace + truncate so a long raw field stays card-sized. */
function snip(s: string | undefined, max: number): string {
  const clean = (s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

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
}

/** Hover edit/delete controls overlaid on a card (edit mode only). */
function CardControls({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover/sb:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit"
        title="Edit"
        className="rounded bg-background/85 p-1 text-muted-foreground shadow-elev-1 hover:text-foreground"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete"
        title="Delete"
        className="rounded bg-background/85 p-1 text-muted-foreground shadow-elev-1 hover:text-destructive"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Per-section "Add …" button (edit mode only). */
function AddCardButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-brand-sm border border-dashed border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add {label}
    </button>
  );
}

export function DashboardSummaryBand({
  dashboardId,
  envelope,
  attentionAreas,
  onAttentionAreaClick,
  onOpenSummary,
  onUpdate,
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

  const { tldr, magnitudes, findings, implications, likelyDrivers, priorityActions } =
    selectSummaryBandData(envelope);
  const attention = selectAttentionAreas(attentionAreas);

  // Raw, uncapped arrays for edit mode (indices map 1:1 to the persisted data).
  const rawMagnitudes = summaryGroupItems("magnitudes", envelope, attentionAreas);
  const rawAttention = summaryGroupItems("attentionAreas", envelope, attentionAreas);
  const rawFindings = summaryGroupItems("findings", envelope, attentionAreas);
  const rawDrivers = summaryGroupItems("likelyDrivers", envelope, attentionAreas);
  const rawImplications = summaryGroupItems("implications", envelope, attentionAreas);
  const rawActions = summaryGroupItems("recommendations", envelope, attentionAreas);

  const hasAnything =
    !!tldr ||
    magnitudes.length > 0 ||
    findings.length > 0 ||
    attention.length > 0 ||
    implications.length > 0 ||
    likelyDrivers.length > 0 ||
    priorityActions.length > 0;

  if (!hasAnything && !isEditing) return null;

  // Section heading row with an optional "Add" button in edit mode.
  const sectionHeader = (
    group: SummaryGroupKey,
    heading: React.ReactNode,
  ) => (
    <div className="mb-2 flex items-center justify-between gap-2">
      <Eyebrow className="flex items-center gap-1.5">{heading}</Eyebrow>
      {isEditing ? (
        <AddCardButton
          label={SUMMARY_GROUPS[group].singular}
          onClick={() => openAdd(group)}
        />
      ) : null}
    </div>
  );

  const editorGroup = editor ? SUMMARY_GROUPS[editor.group] : null;
  const editorInitialValues = (() => {
    if (!editor) return {};
    if (editor.mode === "add") return blankSummaryValues(editor.group);
    const items = summaryGroupItems(editor.group, envelope, attentionAreas);
    const item = items[editor.index];
    return item ? summaryItemToValues(editor.group, item) : blankSummaryValues(editor.group);
  })();

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

      {open ? (
        <div
          id={`dashboard-summary-band-${dashboardId}`}
          className="px-4 pb-4 lg:px-5"
        >
          {tldr ? (
            <Heading size="md" as="p" className="mt-2 max-w-4xl text-foreground/90">
              {tldr}
            </Heading>
          ) : null}

          {/* Key numbers — view mode keeps the signature MagnitudesRow strip;
              edit mode renders an editable gold-card grid from the raw array. */}
          {isEditing ? (
            <div className="mt-4">
              {sectionHeader("magnitudes", "Key numbers")}
              <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                {rawMagnitudes.map((m, i) => (
                  <div
                    key={`mag-${i}`}
                    className="group/sb relative flex flex-col gap-1 rounded-brand-md border border-[hsl(var(--accent-gold)/0.35)] bg-[hsl(var(--accent-gold)/0.08)] px-3 py-2.5"
                    style={{ boxShadow: "inset 0 1px 0 0 hsl(var(--accent-gold) / 0.6)" }}
                  >
                    <CardControls
                      onEdit={() => openEdit("magnitudes", i)}
                      onDelete={() => handleDelete("magnitudes", i)}
                    />
                    <Metric size="sm" className="text-foreground">
                      {String(m.value ?? "")}
                    </Metric>
                    <Caption className="text-foreground/80">{String(m.label ?? "")}</Caption>
                    {m.confidence ? (
                      <div className="mt-0.5">
                        <Badge
                          variant={confidenceVariant(m.confidence as "low" | "medium" | "high")}
                          className="px-1.5 py-0 text-[10px] leading-4"
                        >
                          {String(m.confidence)}
                        </Badge>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <MagnitudesRow items={magnitudes} label="Key numbers" />
          )}

          {/* Attention areas */}
          {isEditing || attention.length > 0 ? (
            <div className="mt-4">
              {sectionHeader("attentionAreas", "Attention areas")}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {((isEditing ? rawAttention : attention) as Array<Record<string, any>>).map((a, i) => {
                  const isRed = a.status === "red";
                  const tone = isRed
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-amber-500/40 bg-amber-500/5";
                  const dot = isRed ? "bg-destructive" : "bg-amber-500";
                  const deltaLabel = isEditing
                    ? `${Math.abs(Math.round(Number(a.variancePct) || 0))}% below avg`
                    : (a as { deltaLabel: string }).deltaLabel;
                  const clickable =
                    !isEditing && Boolean(onAttentionAreaClick && attentionAreas?.[i]);
                  return (
                    <div
                      key={`attn-${i}`}
                      className={cn(
                        "relative flex w-full items-start gap-2 rounded-brand-sm border px-3 py-2 text-left shadow-elev-1",
                        tone,
                        isEditing && "group/sb",
                        clickable && "cursor-pointer hover:opacity-90",
                      )}
                      onClick={
                        clickable
                          ? () => onAttentionAreaClick!(attentionAreas![i])
                          : undefined
                      }
                      title={clickable ? `Filter to ${String(a.unit)}` : undefined}
                    >
                      {isEditing ? (
                        <CardControls
                          onEdit={() => openEdit("attentionAreas", i)}
                          onDelete={() => handleDelete("attentionAreas", i)}
                        />
                      ) : null}
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-snug text-foreground">
                          {String(a.unit)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {String(a.metric)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                        {deltaLabel}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Key findings */}
          {isEditing || findings.length > 0 ? (
            <div className="mt-4">
              {sectionHeader("findings", "Key findings")}
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {(isEditing ? rawFindings : findings).map((f, i) => (
                  <div
                    key={`finding-${i}`}
                    className={cn(
                      "relative rounded-brand-sm border border-border bg-card px-3 py-2 shadow-elev-1",
                      isEditing && "group/sb",
                    )}
                  >
                    {isEditing ? (
                      <CardControls
                        onEdit={() => openEdit("findings", i)}
                        onDelete={() => handleDelete("findings", i)}
                      />
                    ) : null}
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium leading-snug text-foreground">
                        {String(f.headline ?? "")}
                      </span>
                      {f.magnitude ? (
                        <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary tabular-nums">
                          {String(f.magnitude)}
                        </span>
                      ) : null}
                    </div>
                    {f.evidence ? (
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">
                        {snip(String(f.evidence), 160)}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Why it might be happening */}
          {isEditing || likelyDrivers.length > 0 ? (
            <div className="mt-4">
              {sectionHeader(
                "likelyDrivers",
                <>
                  <HelpCircle className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  Why it might be happening
                </>,
              )}
              <p className="mb-2 text-[11px] italic leading-[15px] text-muted-foreground">
                {LIKELY_DRIVERS_DISCLAIMER}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(isEditing ? rawDrivers : likelyDrivers).map((d, i) => (
                  <div
                    key={`driver-${i}`}
                    className={cn(
                      "relative rounded-brand-sm border border-dashed border-border bg-muted/20 px-3 py-2",
                      isEditing && "group/sb",
                    )}
                  >
                    {isEditing ? (
                      <CardControls
                        onEdit={() => openEdit("likelyDrivers", i)}
                        onDelete={() => handleDelete("likelyDrivers", i)}
                      />
                    ) : null}
                    <div className="text-sm leading-snug text-foreground">
                      {snip(String(d.explanation ?? ""), 160)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {DRIVER_BASIS_LABEL[d.basis as "data" | "domain" | "general"] ??
                          String(d.basis)}
                      </span>
                      {d.testable ? (
                        <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                          testable here
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Why it matters */}
          {isEditing || implications.length > 0 ? (
            <div className="mt-4">
              {sectionHeader(
                "implications",
                <>
                  <Compass className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  Why it matters
                </>,
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                {(isEditing ? rawImplications : implications).map((imp, i) => (
                  <div
                    key={`impl-${i}`}
                    className={cn(
                      "relative rounded-brand-sm border border-border bg-muted/20 px-3 py-2 shadow-elev-1",
                      isEditing && "group/sb",
                    )}
                  >
                    {isEditing ? (
                      <CardControls
                        onEdit={() => openEdit("implications", i)}
                        onDelete={() => handleDelete("implications", i)}
                      />
                    ) : null}
                    <div className="text-sm font-medium leading-snug text-foreground">
                      {String(imp.statement ?? "")}
                    </div>
                    <div className="mt-1 text-xs leading-snug text-muted-foreground">
                      <span className="font-medium text-foreground">So what:</span>{" "}
                      {String(imp.soWhat ?? "")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Priority actions */}
          {isEditing || priorityActions.length > 0 ? (
            <div className="mt-4">
              {sectionHeader(
                "recommendations",
                <>
                  <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  Priority actions
                </>,
              )}
              <div className="space-y-2">
                {(isEditing ? rawActions : priorityActions).map((a, i) => (
                  <div
                    key={`action-${i}`}
                    className={cn(
                      "relative flex items-start gap-2 rounded-brand-sm border border-primary/30 bg-primary/5 px-3 py-2 shadow-elev-1",
                      isEditing && "group/sb",
                    )}
                  >
                    {isEditing ? (
                      <CardControls
                        onEdit={() => openEdit("recommendations", i)}
                        onDelete={() => handleDelete("recommendations", i)}
                      />
                    ) : null}
                    <ArrowRight
                      className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium leading-snug text-foreground">
                          {String(a.action ?? "")}
                        </span>
                        {a.horizon ? (
                          <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                            {HORIZON_LABEL[a.horizon as "now" | "this_quarter" | "strategic"]}
                          </span>
                        ) : null}
                      </div>
                      {a.expectedImpact ? (
                        <div className="mt-1 text-xs leading-snug text-muted-foreground">
                          <span className="font-medium text-foreground">
                            Expected impact:
                          </span>{" "}
                          {String(a.expectedImpact)}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
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
