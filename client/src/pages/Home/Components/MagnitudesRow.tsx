import { Badge } from "@/components/ui/badge";
import { Caption, Eyebrow, Metric } from "@/components/ui/typography";
import { cn } from "@/lib/utils";

/**
 * MagnitudesRow — UX-3 · Phase-1 rich envelope surface.
 *
 * Renders the `magnitudes[]` field produced by the synthesiser
 * (PR 1.G) as a compact horizontal row of gold-accent cards. Each
 * card shows the number in `font-metric` (tabular numerics) and the
 * label in `Caption`. Confidence, when present, is a secondary pill.
 *
 * The surface renders nothing (returns null) when the array is empty
 * or missing, so consumers can drop it anywhere without guarding.
 */

export interface MagnitudeItem {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
}

export interface MagnitudesRowProps {
  items?: MagnitudeItem[];
  className?: string;
}

function confidenceVariant(
  c: MagnitudeItem["confidence"]
): "secondary" | "success" | "outline" {
  if (c === "high") return "success";
  if (c === "low") return "outline";
  return "secondary";
}

export function MagnitudesRow({ items, className }: MagnitudesRowProps) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <div className={cn("mt-4", className)}>
      <Eyebrow className="mb-2 block">Magnitudes</Eyebrow>
      <div className="flex flex-wrap gap-3">
        {items.slice(0, 6).map((m, idx) => (
          <div
            key={`${m.label}-${idx}`}
            className={cn(
              "relative flex min-w-[140px] flex-col gap-1",
              "rounded-brand-md border border-[hsl(var(--accent-gold)/0.35)]",
              "bg-[hsl(var(--accent-gold)/0.08)]",
              "px-3 py-2.5"
            )}
            // Single-use gold hairline at the top edge — the "one gold
            // stroke per view" rule lives on the magnitudes row because
            // this is the signature Phase-1 surface.
            style={{
              boxShadow: "inset 0 1px 0 0 hsl(var(--accent-gold) / 0.6)",
            }}
          >
            <Metric size="sm" className="text-foreground">
              {m.value}
            </Metric>
            <Caption className="text-foreground/80">{m.label}</Caption>
            {m.confidence ? (
              <div className="mt-0.5">
                <Badge
                  variant={confidenceVariant(m.confidence)}
                  className="px-1.5 py-0 text-[10px] leading-4"
                >
                  {m.confidence}
                </Badge>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
