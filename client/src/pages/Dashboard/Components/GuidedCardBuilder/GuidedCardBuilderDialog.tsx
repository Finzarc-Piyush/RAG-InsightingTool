import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { dashboardsApi } from "@/lib/api";
import type {
  BuilderMetadata,
  BuilderMeasure,
  TilePreviewResult,
} from "@/lib/api/dashboards";
import type { DashboardCardDefinition } from "@/shared/schema";
import { DashboardScorecard } from "../DashboardScorecard";
import { FilterChainEditor, type CardFilter } from "./FilterChainEditor";
import { cn } from "@/lib/utils";

/**
 * Wave W10–W12 (data-bound cards) · the Power-BI-style GUIDED CARD BUILDER.
 * The user composes a card by SELECTION ONLY — pick a measure, a (constrained)
 * aggregation, an optional breakdown, and value filters — and a live preview
 * runs the real query. No free-typed numbers: the AggregationSelect greys the
 * illegal aggregations (you can't SUM a percentage), enforced on both ends.
 */

type CardType = "scorecard" | "chart" | "table";
type Agg = BuilderMeasure["allowedAggregations"][number];

const AGG_LABELS: Record<Agg, string> = {
  sum: "Sum",
  avg: "Average",
  count: "Count",
  min: "Min",
  max: "Max",
  median: "Median",
};
const ALL_AGGS: Agg[] = ["sum", "avg", "count", "min", "max", "median"];

export function GuidedCardBuilderDialog({
  dashboardId,
  sheetId,
  open,
  onOpenChange,
  onComposed,
}: {
  dashboardId: string;
  sheetId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComposed: () => void | Promise<void>;
}) {
  const [meta, setMeta] = useState<BuilderMetadata | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [cardType, setCardType] = useState<CardType>("scorecard");
  const [measureRef, setMeasureRef] = useState<string>("");
  const [aggregation, setAggregation] = useState<Agg>("sum");
  const [breakdown, setBreakdown] = useState<string>("");
  const [filters, setFilters] = useState<CardFilter[]>([]);
  const [preview, setPreview] = useState<TilePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch the picker metadata once per open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setMeta(null);
    setMetaError(null);
    dashboardsApi
      .getBuilderMetadata(dashboardId)
      .then((m) => {
        if (!alive) return;
        setMeta(m);
        const first = m.measures[0];
        if (first) {
          setMeasureRef(first.ref);
          setAggregation(first.defaultAggregation);
        }
      })
      .catch((e) =>
        alive ? setMetaError(e instanceof Error ? e.message : "Failed to load fields") : undefined
      );
    return () => {
      alive = false;
    };
  }, [open, dashboardId]);

  const selectedMeasure = useMemo(
    () => meta?.measures.find((m) => m.ref === measureRef) ?? null,
    [meta, measureRef]
  );

  const cardDefinition: DashboardCardDefinition | null = useMemo(() => {
    if (!selectedMeasure) return null;
    return {
      cardType,
      measure: {
        kind: selectedMeasure.kind,
        ref: selectedMeasure.ref,
        label: selectedMeasure.label,
      },
      aggregation,
      groupBy: cardType === "scorecard" ? [] : breakdown ? [breakdown] : [],
      filters: filters
        .filter((f) => f.column && f.values.length > 0)
        .map((f) => ({ column: f.column, op: "in" as const, values: f.values })),
      ...(cardType === "scorecard"
        ? { comparison: { mode: "period_over_period" as const } }
        : {}),
    };
  }, [selectedMeasure, cardType, aggregation, breakdown, filters]);

  // When the measure changes, snap the aggregation to its default.
  const onMeasureChange = (ref: string) => {
    setMeasureRef(ref);
    const m = meta?.measures.find((x) => x.ref === ref);
    if (m) setAggregation(m.defaultAggregation);
  };

  const needsBreakdown = cardType !== "scorecard";
  const canAdd = !!cardDefinition && (!needsBreakdown || !!breakdown) && !previewError;

  // Debounced live preview.
  useEffect(() => {
    if (!open || !cardDefinition) return;
    if (needsBreakdown && !breakdown) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setPreviewing(true);
    debounceRef.current = setTimeout(() => {
      dashboardsApi
        .previewTile(dashboardId, cardDefinition)
        .then((res) => {
          setPreview(res);
          setPreviewError(null);
        })
        .catch((e) => {
          setPreview(null);
          setPreviewError(
            e?.response?.data?.error || (e instanceof Error ? e.message : "Preview failed")
          );
        })
        .finally(() => setPreviewing(false));
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, dashboardId, cardDefinition, needsBreakdown, breakdown]);

  const handleAdd = async () => {
    if (!cardDefinition || adding) return;
    setAdding(true);
    try {
      await dashboardsApi.composeTile(dashboardId, cardDefinition, { sheetId });
      await onComposed();
      onOpenChange(false);
    } catch {
      /* the preview already surfaces errors; keep the dialog open */
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Build a card</DialogTitle>
          <DialogDescription>
            Pick a measure, an aggregation, and optional filters — the card is computed from
            your data. No typing numbers by hand.
          </DialogDescription>
        </DialogHeader>

        {metaError ? (
          <p className="text-sm text-destructive">{metaError}</p>
        ) : !meta ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading fields…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_1fr]">
            {/* ---- Left: the selection controls ---- */}
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Card type</Label>
                <ToggleGroup
                  type="single"
                  value={cardType}
                  onValueChange={(v) => v && setCardType(v as CardType)}
                  className="mt-1 justify-start gap-1"
                >
                  {(["scorecard", "chart", "table"] as CardType[]).map((t) => (
                    <ToggleGroupItem
                      key={t}
                      value={t}
                      className="h-7 rounded-brand-sm border border-border/60 px-2.5 text-xs capitalize data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                    >
                      {t === "scorecard" ? "KPI" : t}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <div>
                <Label className="text-xs">Measure</Label>
                <Select value={measureRef || undefined} onValueChange={onMeasureChange}>
                  <SelectTrigger className="mt-1 h-8 text-xs">
                    <SelectValue placeholder="Pick a measure" />
                  </SelectTrigger>
                  <SelectContent>
                    {meta.measures.map((m) => (
                      <SelectItem key={m.ref} value={m.ref} className="text-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs">Aggregation</Label>
                <div className="mt-1 flex flex-wrap gap-1">
                  {ALL_AGGS.map((a) => {
                    const allowed = selectedMeasure?.allowedAggregations.includes(a) ?? false;
                    const isActive = aggregation === a;
                    return (
                      <button
                        key={a}
                        type="button"
                        disabled={!allowed}
                        title={
                          !allowed
                            ? a === "sum"
                              ? "Can't sum a percentage — averaging only"
                              : "Not available for this measure"
                            : undefined
                        }
                        onClick={() => allowed && setAggregation(a)}
                        className={cn(
                          "h-7 rounded-brand-sm border px-2.5 text-xs transition-colors",
                          allowed
                            ? isActive
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border/60 hover:bg-muted"
                            : "cursor-not-allowed border-border/40 text-muted-foreground/40"
                        )}
                      >
                        {AGG_LABELS[a]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {needsBreakdown ? (
                <div>
                  <Label className="text-xs">Break down by</Label>
                  <Select value={breakdown || undefined} onValueChange={setBreakdown}>
                    <SelectTrigger className="mt-1 h-8 text-xs">
                      <SelectValue placeholder="Pick a dimension" />
                    </SelectTrigger>
                    <SelectContent>
                      {meta.dimensions.map((d) => (
                        <SelectItem key={d.column} value={d.column} className="text-xs">
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}

              <div>
                <Label className="text-xs">Filters</Label>
                <div className="mt-1">
                  <FilterChainEditor
                    dimensions={meta.dimensions}
                    filters={filters}
                    onChange={setFilters}
                  />
                </div>
              </div>
            </div>

            {/* ---- Right: the live preview ---- */}
            <div className="rounded-brand-md border border-border/60 bg-muted/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Live preview
                {previewing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              </div>
              <PreviewPane preview={preview} error={previewError} needsBreakdown={needsBreakdown} breakdown={breakdown} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!canAdd || adding}>
            {adding ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Add to dashboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewPane({
  preview,
  error,
  needsBreakdown,
  breakdown,
}: {
  preview: TilePreviewResult | null;
  error: string | null;
  needsBreakdown: boolean;
  breakdown: string;
}) {
  if (error) {
    const msg =
      error === "cannot_sum_non_additive" ? "Can't sum a percentage." : error;
    return <p className="text-sm text-destructive">{msg}</p>;
  }
  if (needsBreakdown && !breakdown) {
    return <p className="text-sm text-muted-foreground">Pick a dimension to preview.</p>;
  }
  if (!preview) {
    return <p className="text-sm text-muted-foreground">Adjust the selections to preview.</p>;
  }
  if (preview.cardType === "scorecard") {
    return <DashboardScorecard scorecard={preview.scorecard} />;
  }
  if (preview.cardType === "table") {
    const t = preview.table;
    return (
      <div className="max-h-56 overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {t.columns.map((c) => (
                <th key={c} className="px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.rows.slice(0, 12).map((r, i) => (
              <tr key={i} className="border-b border-border/40">
                {r.map((cell, j) => (
                  <td key={j} className="px-2 py-1">
                    {cell == null ? "—" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // chart — compact descriptor (the full chart renders once added).
  const c = preview.chart;
  return (
    <div className="text-sm">
      <div className="font-medium">{c.title}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {c.type} · {c.x} × {c.y}
        {c.seriesColumn ? ` · by ${c.seriesColumn}` : ""} · {c.data?.length ?? 0} points
      </div>
    </div>
  );
}
