import { useMemo } from "react";
import { groupedMarks, type MarkMeta } from "@/lib/charts/markMeta";
import type { ChartV2Mark } from "@/shared/schema";
import { cn } from "@/lib/utils";

interface MarkGalleryProps {
  value: ChartV2Mark | null;
  onChange: (mark: ChartV2Mark) => void;
}

export function MarkGallery({ value, onChange }: MarkGalleryProps) {
  const groups = useMemo(() => groupedMarks(), []);

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.group}>
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {g.group}
          </h4>
          <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
            {g.items.map((it) => (
              <MarkCard
                key={it.mark}
                meta={it}
                selected={value === it.mark}
                onClick={() => onChange(it.mark)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MarkCard({
  meta,
  selected,
  onClick,
}: {
  meta: MarkMeta;
  selected: boolean;
  onClick: () => void;
}) {
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 p-3 text-center transition-all",
        "hover:bg-muted/50 hover:border-primary/40 hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected
          ? "border-primary bg-primary/10 shadow-sm"
          : "border-border/60 bg-card",
      )}
    >
      <Icon
        className={cn(
          "h-6 w-6",
          selected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "text-[11px] font-medium leading-tight",
          selected ? "text-primary" : "text-foreground",
        )}
      >
        {meta.label}
      </span>
    </button>
  );
}
