/**
 * EncodingShelves — click-to-edit shelves that bind columns to chart
 * encoding channels. WC2.3.
 *
 * Each shelf (X / Y / Color / Size / FacetCol / FacetRow / Filter)
 * shows the current field as a chip. Click empty shelf → popover with
 * the dataset's columns + their inferred types. Click a chip's ✕ to
 * clear that channel.
 *
 * Why a click-to-pick popover instead of full @dnd-kit drag-and-drop:
 * the popover is keyboard-friendly, faster to use, and has zero DnD
 * overhead. Drag-and-drop can be layered on later if specifically
 * requested — the same shelf API will accept either input source.
 */

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type {
  ChartEncoding,
  ChartEncodingChannel,
  ChartFieldType,
} from "@/shared/schema";
import type { Row } from "@/lib/charts/encodingResolver";
import { asNumber } from "@/lib/charts/encodingResolver";

type ChannelKey =
  | "x"
  | "y"
  | "y2"
  | "color"
  | "size"
  | "shape"
  | "pattern"
  | "detail"
  | "facetCol"
  | "facetRow";

interface ShelfDef {
  key: ChannelKey;
  label: string;
  /** Tighten which field types are accepted in this shelf. */
  accepts: ChartFieldType[] | null;
  /** Multi-select: future. */
}

const SHELVES: ShelfDef[] = [
  { key: "x", label: "X", accepts: null },
  { key: "y", label: "Y", accepts: ["q"] },
  { key: "y2", label: "Y₂", accepts: ["q"] },
  { key: "color", label: "Color", accepts: null },
  { key: "size", label: "Size", accepts: ["q"] },
  { key: "shape", label: "Shape", accepts: ["n", "o"] },
  { key: "pattern", label: "Pattern", accepts: ["n", "o"] },
  { key: "detail", label: "Detail", accepts: ["n", "o"] },
  { key: "facetCol", label: "Facet ↻", accepts: ["n", "o"] },
  { key: "facetRow", label: "Facet ↕", accepts: ["n", "o"] },
];

interface InferredColumn {
  field: string;
  type: ChartFieldType;
  /** Distinct count among the first N rows; useful for cardinality hints. */
  cardinality: number;
}

function inferColumns(rows: Row[], sampleSize = 200): InferredColumn[] {
  if (rows.length === 0) return [];
  const sample = rows.slice(0, sampleSize);
  const fields = new Set<string>();
  for (const r of sample) {
    for (const k of Object.keys(r)) fields.add(k);
  }
  return Array.from(fields).map((field) => {
    let numericCount = 0;
    let dateCount = 0;
    let total = 0;
    const distinct = new Set<string>();
    for (const r of sample) {
      const v = r[field];
      if (v == null || v === "") continue;
      total += 1;
      distinct.add(String(v));
      if (typeof v === "number" && Number.isFinite(v)) {
        numericCount += 1;
      } else if (typeof v === "string") {
        const n = asNumber(v);
        if (Number.isFinite(n)) numericCount += 1;
        else if (!Number.isNaN(Date.parse(v))) dateCount += 1;
      }
    }
    let type: ChartFieldType;
    if (total > 0 && dateCount / total > 0.5) type = "t";
    else if (total > 0 && numericCount / total > 0.7) type = "q";
    else if (distinct.size <= 24) type = "n";
    else type = "o";
    return { field, type, cardinality: distinct.size };
  });
}

const TYPE_BADGE: Record<ChartFieldType, string> = {
  q: "#",
  n: "Aa",
  o: "1·2",
  t: "🕐",
};

const TYPE_LABEL: Record<ChartFieldType, string> = {
  q: "quantitative",
  n: "nominal",
  o: "ordinal",
  t: "temporal",
};

export interface EncodingShelvesProps {
  encoding: ChartEncoding;
  onChange: (next: ChartEncoding) => void;
  /** Rows to derive column list + inferred types. */
  rows: Row[];
  className?: string;
  compact?: boolean;
}

export function EncodingShelves({
  encoding,
  onChange,
  rows,
  className,
  compact = false,
}: EncodingShelvesProps) {
  const columns = useMemo(() => inferColumns(rows), [rows]);

  const setChannel = (key: ChannelKey, channel: ChartEncodingChannel | null) => {
    const next = { ...encoding };
    if (channel) {
      (next as Record<ChannelKey, ChartEncodingChannel | undefined>)[key] = channel;
    } else {
      delete (next as Record<ChannelKey, ChartEncodingChannel | undefined>)[key];
    }
    onChange(next);
  };

  return (
    <div
      role="group"
      aria-label="Chart encoding shelves"
      className={cn(
        "grid gap-1.5",
        compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7",
        className,
      )}
    >
      {SHELVES.map((shelf) => {
        const current = encoding[shelf.key as keyof ChartEncoding] as
          | ChartEncodingChannel
          | undefined;
        const allowed = shelf.accepts
          ? columns.filter((c) => shelf.accepts!.includes(c.type))
          : columns;
        return (
          <Shelf
            key={shelf.key}
            shelf={shelf}
            current={current}
            columns={allowed}
            onPick={(col) =>
              setChannel(shelf.key, { field: col.field, type: col.type })
            }
            onClear={() => setChannel(shelf.key, null)}
            compact={compact}
          />
        );
      })}
    </div>
  );
}

interface ShelfProps {
  shelf: ShelfDef;
  current?: ChartEncodingChannel;
  columns: InferredColumn[];
  onPick: (col: InferredColumn) => void;
  onClear: () => void;
  compact: boolean;
}

function Shelf({ shelf, current, columns, onPick, onClear, compact }: ShelfProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "group flex items-center justify-between gap-1 rounded-md border border-border/60 bg-card text-left transition-colors hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40",
          compact ? "h-7 px-2 text-[11px]" : "h-9 px-2.5 text-xs",
        )}
        aria-label={`Encoding shelf: ${shelf.label}`}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {shelf.label}
        </span>
        {current ? (
          <span className="flex min-w-0 flex-1 items-center justify-end gap-1">
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-primary/10 text-[9px] font-medium text-primary"
              title={TYPE_LABEL[current.type]}
            >
              {TYPE_BADGE[current.type]}
            </span>
            <span className="min-w-0 flex-shrink truncate font-medium text-foreground">
              {current.field}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClear();
              }}
              className="ml-1 inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              aria-label={`Clear ${shelf.label}`}
            >
              <X className="h-2.5 w-2.5" strokeWidth={2.5} />
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Plus className="h-3 w-3" />
            <span>add</span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[320px] w-56 overflow-y-auto p-1"
      >
        {columns.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">
            No columns of accepted type
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {columns.map((col) => (
              <li key={col.field}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(col);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                >
                  <span
                    className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-medium text-muted-foreground"
                    title={TYPE_LABEL[col.type]}
                  >
                    {TYPE_BADGE[col.type]}
                  </span>
                  <span className="flex-1 truncate font-medium text-foreground">
                    {col.field}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {col.cardinality}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
