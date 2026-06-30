/**
 * W42 · StreamingPreviewCard  (redesigned)
 *
 * Renders the W38 `streamingNarratorPreview` text (cleaned by W41's
 * server-side body-field extractor) as a live answer preview while the agent
 * loop is still running. Once the turn completes the final structured
 * AnswerCard takes over and this preview unmounts.
 *
 * The earlier "DRAFTING ANSWER…" label read as half-baked, leaked text. This
 * version signals an INTENTIONAL live stream: a pulsing "live" dot + an
 * "Answering live…" label, with the preview body deliberately de-emphasized
 * (muted, italic) so it never masquerades as the finished answer.
 *
 * Three independent guards keep this hidden when not in active streaming
 * mode:
 *   1. `isPending` is false → nothing to stream → render null
 *   2. `previewText` is empty → no chunks have arrived → render null
 *   3. (implicit) when STREAMING_NARRATOR_ENABLED is unset on the
 *      server, no `answer_chunk` events fire and `previewText` stays ""
 *
 * Theming uses semantic tokens only (per client/THEMING.md): bg-muted/30,
 * border-border, text-foreground, text-muted-foreground, bg-primary,
 * text-primary. No raw hex / Tailwind palette literals.
 */
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
      aria-label="Answering live"
      aria-live="polite"
    >
      <div className="mb-1.5 flex items-center gap-2">
        {/* Pulsing "live" dot — reads as an intentional stream, not leaked text. */}
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">
          Answering live…
        </span>
      </div>
      <p className="whitespace-pre-wrap text-[14px] italic leading-[22px] text-muted-foreground">
        {previewText}
      </p>
    </section>
  );
}
