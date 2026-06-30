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
  /** @deprecated legacy field — no longer surfaced on key-number cards. */
  confidence?: "low" | "medium" | "high";
  /** W-SBCOLOR · user-chosen card colour. The value IS the colour:
   *  green = best/positive, red = worst/negative, amber = neutral. */
  tone?: MagnitudeTone;
}

export type MagnitudeTone = "green" | "amber" | "red";

/**
 * W-SBCOLOR · colour classes for a tone-coded key-number card. Reuses the
 * existing semantic tokens (`--success`, `--destructive`, Tailwind `amber-500`)
 * already used by the Attention-areas callout, so the palette stays consistent.
 * A card with NO tone keeps the signature gold treatment (see below).
 */
export function magnitudeToneClasses(tone: MagnitudeTone): string {
  // A solid coloured LEFT bar (border-l-4) + a clear tint makes the colour
  // unmistakable at a glance — green = best, red = worst, amber = neutral.
  switch (tone) {
    case "green":
      return "border border-[hsl(var(--success)/0.30)] border-l-4 border-l-[hsl(var(--success))] bg-[hsl(var(--success)/0.12)]";
    case "red":
      return "border border-destructive/30 border-l-4 border-l-destructive bg-destructive/12";
    case "amber":
    default:
      return "border border-amber-500/30 border-l-4 border-l-amber-500 bg-amber-500/12";
  }
}

export interface MagnitudesRowProps {
  items?: MagnitudeItem[];
  className?: string;
  /** Eyebrow label above the row. Defaults to "Magnitudes" (chat surface). */
  label?: string;
}

/** A KPI strip stays scannable as a strip, not a wall — cap the cards. */
const MAX_KPI_CARDS = 6;

function confidenceVariant(
  c: MagnitudeItem["confidence"]
): "secondary" | "success" | "outline" {
  if (c === "high") return "success";
  if (c === "low") return "outline";
  return "secondary";
}

export function MagnitudesRow({ items, className, label = "Magnitudes" }: MagnitudesRowProps) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <div className={cn("mt-4", className)}>
      <Eyebrow className="mb-2 block">{label}</Eyebrow>
      {/* EXD8 · equal-width/height grid (auto-rows-fr) instead of a ragged
          flex-wrap: KPI cards line up in clean columns and share a row height,
          so the band reads as an aligned strip rather than uneven cards. */}
      <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
        {items.slice(0, MAX_KPI_CARDS).map((m, idx) => {
          // W-SBCOLOR · a tone-coded card uses the semantic colour; a card with
          // no tone keeps the signature single-use gold treatment (unchanged
          // chat behaviour). Confidence is only shown on the legacy gold card.
          const toned = !!m.tone;
          return (
            <div
              key={`${m.label}-${idx}`}
              className={cn(
                "relative flex flex-col gap-1 rounded-brand-md border px-3 py-2.5",
                toned
                  ? magnitudeToneClasses(m.tone!)
                  : "border-[hsl(var(--accent-gold)/0.35)] bg-[hsl(var(--accent-gold)/0.08)]"
              )}
              // Single-use gold hairline at the top edge — only on the
              // untoned (signature) card, per the "one gold stroke per view" rule.
              style={
                toned
                  ? undefined
                  : { boxShadow: "inset 0 1px 0 0 hsl(var(--accent-gold) / 0.6)" }
              }
            >
              <Metric size="sm" className="text-foreground">
                {m.value}
              </Metric>
              <Caption className="text-foreground/80">{m.label}</Caption>
              {!toned && m.confidence ? (
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
          );
        })}
      </div>
    </div>
  );
}
