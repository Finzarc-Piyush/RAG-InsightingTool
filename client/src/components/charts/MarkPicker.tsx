import { BarChart3 as BarIcon, ChevronDown } from "lucide-react";
import { useMemo } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChartEncoding, ChartV2Mark } from "@/shared/schema";
import { MARKS, groupedMarks } from "@/lib/charts/markMeta";

export interface MarkPickerProps {
  /** Current selected mark. */
  value: ChartV2Mark;
  /** Current encoding (used to compute disabled state). */
  encoding: ChartEncoding;
  onChange: (mark: ChartV2Mark) => void;
  className?: string;
  /** Compact trigger for dense pivot panels. */
  compact?: boolean;
}

export function MarkPicker({
  value,
  encoding,
  onChange,
  className,
  compact = false,
}: MarkPickerProps) {
  const grouped = useMemo(() => groupedMarks(), []);

  const current = MARKS.find((m) => m.mark === value);
  const CurrentIcon = current?.icon ?? BarIcon;

  return (
    <Select value={value} onValueChange={(v) => onChange(v as ChartV2Mark)}>
      <SelectTrigger
        className={
          (compact ? "h-7 px-2 text-xs " : "h-9 px-3 text-sm ") +
          "inline-flex items-center gap-2 rounded-md border-border/80 bg-card text-foreground hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/40 " +
          (className ?? "")
        }
        aria-label="Chart type"
      >
        <CurrentIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue placeholder="Pick a chart type" />
        <ChevronDown className="ml-auto h-3.5 w-3.5 opacity-60" />
      </SelectTrigger>
      <SelectContent className="max-h-[420px]">
        {grouped.map((g) => (
          <div key={g.group}>
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((it) => {
              const reason = it.requires(encoding);
              const disabled = reason !== null;
              const Icon = it.icon;
              return (
                <SelectItem
                  key={it.mark}
                  value={it.mark}
                  disabled={disabled}
                  title={reason ?? undefined}
                  className="data-[disabled]:opacity-50"
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5" />
                    <span>{it.label}</span>
                  </span>
                </SelectItem>
              );
            })}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}
