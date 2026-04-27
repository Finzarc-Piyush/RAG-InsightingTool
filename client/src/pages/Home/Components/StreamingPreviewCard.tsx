/**
 * W42 · StreamingPreviewCard
 *
 * Renders the W38 `streamingNarratorPreview` text (cleaned by W41's
 * server-side body-field extractor) as a live "Drafting answer…"
 * preview while the agent loop is still running. Once the turn completes
 * the final structured AnswerCard takes over and this preview unmounts.
 *
 * Three independent guards keep this hidden when not in active streaming
 * mode:
 *   1. `isPending` is false → nothing to stream → render null
 *   2. `previewText` is empty → no chunks have arrived → render null
 *   3. (implicit) when STREAMING_NARRATOR_ENABLED is unset on the
 *      server, no `answer_chunk` events fire and `previewText` stays ""
 *
 * Theming uses semantic tokens only (per client/THEMING.md): bg-muted/30,
 * border-border, text-foreground, text-muted-foreground, bg-primary/10,
 * text-primary. No raw hex / Tailwind palette literals.
 */
import { Sparkles } from "lucide-react";

interface StreamingPreviewCardProps {
  previewText: string;
  isPending: boolean;
}

export function StreamingPreviewCard({
  previewText,
  isPending,
}: StreamingPreviewCardProps) {
  if (!isPending) return null;
  if (!previewText.trim()) return null;
  return (
    <section
      className="mb-3 rounded-brand-md border border-border/60 bg-muted/30 px-4 py-3"
      aria-label="Drafting answer (live)"
      aria-live="polite"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <Sparkles
          className="h-3.5 w-3.5 animate-pulse text-primary motion-reduce:animate-none"
          aria-hidden
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          Drafting answer…
        </span>
      </div>
      <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-foreground/85">
        {previewText}
      </p>
    </section>
  );
}
