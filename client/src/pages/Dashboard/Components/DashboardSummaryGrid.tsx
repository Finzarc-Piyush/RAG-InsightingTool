import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Layout, Layouts } from "react-grid-layout";
import { ArrowRight, Compass, HelpCircle, ListChecks, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  magnitudeToneClasses,
  type MagnitudeTone,
} from "@/pages/Home/Components/MagnitudesRow";
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";
import {
  ResponsiveGridLayout,
  GRID_COLS,
  GRID_ROW_HEIGHT,
  GRID_MARGIN,
  allResizeHandles,
} from "./dashboardGridConstants";
import {
  buildSummaryLayouts,
  flattenSummaryCards,
  type SummaryCard,
} from "../lib/summaryGridLayout";
import type { SummaryGroupKey } from "../lib/summaryBandEdit";

/**
 * W-SBGRID · the Executive-Summary band's free-form card canvas.
 *
 * Replaces the band's six fixed CSS-grid sections with ONE react-grid-layout
 * (the same engine the chart tiles use), so every card — key number, attention
 * area, finding, … — can be dragged + resized in edit mode and its position
 * persists per dashboard. View mode renders the same arrangement, just inert.
 * Pure layout maths live in `../lib/summaryGridLayout`; this component is the
 * thin React shell + the per-type card bodies.
 */
export interface DashboardSummaryGridProps {
  envelope?: DashboardAnswerEnvelope;
  attentionAreas?: AttentionAreaSpec[];
  /** Drag/resize + hover controls only when true. */
  isEditing: boolean;
  /** Saved positions (dashboard.summaryGridLayout). */
  serverLayout?: Layouts | null;
  /** Debounced persist on a user drag/resize. */
  onPersistLayout?: (layouts: Layouts) => void;
  onEditCard?: (group: SummaryGroupKey, index: number) => void;
  onDeleteCard?: (group: SummaryGroupKey, index: number) => void;
  /** View-mode drill: click an attention area to filter into it. */
  onAttentionAreaClick?: (index: number) => void;
}

const DRIVER_BASIS_LABEL: Record<"data" | "domain" | "general", string> = {
  data: "from the data",
  domain: "industry knowledge",
  general: "general knowledge",
};
const HORIZON_LABEL: Record<"now" | "this_quarter" | "strategic", string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

function snip(s: unknown, max: number): string {
  const clean = String(s ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Hover edit/delete controls. `.sb-no-drag` keeps clicks from starting a drag. */
function CardControls({ onEdit, onDelete }: { onEdit?: () => void; onDelete?: () => void }) {
  if (!onEdit && !onDelete) return null;
  return (
    <div className="sb-no-drag absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover/sb:opacity-100 focus-within:opacity-100">
      {onEdit ? (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          title="Edit"
          className="rounded bg-background/85 p-1 text-muted-foreground shadow-elev-1 hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete"
          title="Delete"
          className="rounded bg-background/85 p-1 text-muted-foreground shadow-elev-1 hover:text-destructive"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

/** The body of a single card, switched on its group. */
function SummaryCardBody({
  card,
  isEditing,
  onAttentionAreaClick,
}: {
  card: SummaryCard;
  isEditing: boolean;
  onAttentionAreaClick?: (index: number) => void;
}) {
  const m = card.item;
  switch (card.group) {
    case "magnitudes":
      return (
        <div
          className={cn(
            "flex h-full w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-brand-md px-3 py-2 text-center",
            magnitudeToneClasses((m.tone as MagnitudeTone) ?? "amber"),
          )}
          // W-SBGRID · make the card a query container so the number + label
          // font sizes scale fluidly with the card's size (cqmin = the smaller
          // of the card's width/height), centred both ways.
          style={{ containerType: "size" }}
        >
          <span className="max-w-full truncate font-metric font-medium leading-none text-foreground text-[length:clamp(1rem,26cqmin,3.5rem)] [font-variant-numeric:tabular-nums]">
            {String(m.value ?? "")}
          </span>
          <span className="line-clamp-2 max-w-full leading-tight text-foreground/70 text-[length:clamp(0.58rem,8cqmin,1rem)]">
            {String(m.label ?? "")}
          </span>
        </div>
      );
    case "attentionAreas": {
      const isRed = m.status === "red";
      const tone = isRed ? "border-destructive/40 bg-destructive/5" : "border-amber-500/40 bg-amber-500/5";
      const dot = isRed ? "bg-destructive" : "bg-amber-500";
      const clickable = !isEditing && !!onAttentionAreaClick;
      return (
        <div
          className={cn(
            "flex h-full w-full items-start gap-2 overflow-hidden rounded-brand-sm border px-3 py-2 text-left shadow-elev-1",
            tone,
            clickable && "sb-no-drag cursor-pointer hover:opacity-90",
          )}
          onClick={clickable ? () => onAttentionAreaClick!(card.index) : undefined}
          title={clickable ? `Filter to ${String(m.unit)}` : undefined}
        >
          <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium leading-snug text-foreground">
              {String(m.unit ?? "")}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{String(m.metric ?? "")}</span>
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            {`${Math.abs(Math.round(Number(m.variancePct) || 0))}% below avg`}
          </span>
        </div>
      );
    }
    case "findings":
      return (
        <div className="h-full overflow-hidden rounded-brand-sm border border-border bg-card px-3 py-2 shadow-elev-1">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium leading-snug text-foreground">
              {String(m.headline ?? "")}
            </span>
            {m.magnitude ? (
              <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary tabular-nums">
                {String(m.magnitude)}
              </span>
            ) : null}
          </div>
          {m.evidence ? (
            <p className="mt-1 text-xs leading-snug text-muted-foreground">{snip(m.evidence, 220)}</p>
          ) : null}
        </div>
      );
    case "likelyDrivers":
      return (
        <div className="h-full overflow-hidden rounded-brand-sm border border-dashed border-border bg-muted/20 px-3 py-2">
          <div className="text-sm leading-snug text-foreground">{snip(m.explanation, 220)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {DRIVER_BASIS_LABEL[m.basis as "data" | "domain" | "general"] ?? String(m.basis ?? "")}
            </span>
            {m.testable ? (
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                testable here
              </span>
            ) : null}
          </div>
        </div>
      );
    case "implications":
      return (
        <div className="h-full overflow-hidden rounded-brand-sm border border-border bg-muted/20 px-3 py-2 shadow-elev-1">
          <div className="text-sm font-medium leading-snug text-foreground">{String(m.statement ?? "")}</div>
          <div className="mt-1 text-xs leading-snug text-muted-foreground">
            <span className="font-medium text-foreground">So what:</span> {snip(m.soWhat, 200)}
          </div>
        </div>
      );
    case "recommendations":
      return (
        <div className="flex h-full items-start gap-2 overflow-hidden rounded-brand-sm border border-primary/30 bg-primary/5 px-3 py-2 shadow-elev-1">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-medium leading-snug text-foreground">{String(m.action ?? "")}</span>
              {m.horizon ? (
                <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                  {HORIZON_LABEL[m.horizon as "now" | "this_quarter" | "strategic"]}
                </span>
              ) : null}
            </div>
            {m.expectedImpact ? (
              <div className="mt-1 text-xs leading-snug text-muted-foreground">
                <span className="font-medium text-foreground">Expected impact:</span> {String(m.expectedImpact)}
              </div>
            ) : null}
          </div>
        </div>
      );
  }
}

/** Small icon prefix per group, used as an a11y label hint. */
const GROUP_ICON: Partial<Record<SummaryGroupKey, typeof HelpCircle>> = {
  likelyDrivers: HelpCircle,
  implications: Compass,
  recommendations: ListChecks,
};

export function DashboardSummaryGrid({
  envelope,
  attentionAreas,
  isEditing,
  serverLayout,
  onPersistLayout,
  onEditCard,
  onDeleteCard,
  onAttentionAreaClick,
}: DashboardSummaryGridProps) {
  const cards = useMemo(
    () => flattenSummaryCards(envelope, attentionAreas),
    [envelope, attentionAreas],
  );
  const cardsSig = cards.map((c) => `${c.gridId}:${c.group}`).join("|");
  const savedSig = JSON.stringify(serverLayout ?? null);

  const computed = useMemo(
    () => buildSummaryLayouts(cards, serverLayout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardsSig, savedSig],
  );

  const [layouts, setLayouts] = useState<Layouts>(computed);
  const layoutsRef = useRef<Layouts>(computed);
  // Re-seed when the card SET changes (add/delete) or a save round-trips back.
  useEffect(() => {
    setLayouts(computed);
    layoutsRef.current = computed;
  }, [computed]);

  // Visual updates flow through here continuously; we persist ONLY on an
  // explicit drag/resize stop (below) so refetch-driven re-renders never write.
  const handleLayoutChange = useCallback((_current: Layout[], all: Layouts) => {
    layoutsRef.current = all;
    setLayouts(all);
  }, []);

  const persistNow = useCallback(() => {
    if (isEditing) onPersistLayout?.(layoutsRef.current);
  }, [isEditing, onPersistLayout]);

  if (cards.length === 0) return null;

  return (
    <ResponsiveGridLayout
      className="dashboard-summary-grid mt-3"
      layouts={layouts}
      cols={GRID_COLS}
      rowHeight={GRID_ROW_HEIGHT}
      margin={GRID_MARGIN}
      isDraggable={isEditing}
      isResizable={isEditing}
      resizeHandles={isEditing ? allResizeHandles() : []}
      onLayoutChange={handleLayoutChange}
      onDragStop={persistNow}
      onResizeStop={persistNow}
      compactType="vertical"
      preventCollision={false}
      draggableCancel=".sb-no-drag"
    >
      {cards.map((card) => {
        const Icon = GROUP_ICON[card.group];
        return (
          <div
            key={card.gridId}
            className={cn(
              "group/sb relative h-full w-full rounded-brand-md outline-none",
              isEditing && "cursor-grab active:cursor-grabbing",
            )}
            role="group"
            aria-roledescription="summary card"
          >
            {isEditing ? (
              <CardControls
                onEdit={onEditCard ? () => onEditCard(card.group, card.index) : undefined}
                onDelete={onDeleteCard ? () => onDeleteCard(card.group, card.index) : undefined}
              />
            ) : null}
            {Icon ? (
              <Icon
                className="pointer-events-none absolute left-2 top-2 z-10 h-3 w-3 text-primary/70"
                aria-hidden="true"
              />
            ) : null}
            <SummaryCardBody
              card={card}
              isEditing={isEditing}
              onAttentionAreaClick={onAttentionAreaClick}
            />
          </div>
        );
      })}
    </ResponsiveGridLayout>
  );
}
