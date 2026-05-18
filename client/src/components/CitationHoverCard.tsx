"use client";

import * as React from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { formatCitationLabel } from "@/lib/citationTokens";

/**
 * Wave WQ3 · render a single domain-pack citation as a superscript
 * Radix HoverCard. The narrator's prose contains backtick-wrapped pack
 * IDs (e.g. `` `marico-haircare-portfolio` ``); the server-side W22 gate
 * guarantees every cited ID is real (no hallucinated packs). The
 * MarkdownRenderer detects these via `extractCitations` and wraps each
 * one in this component instead of plain text.
 *
 * Hover-card content (metadata-only): humanised pack label + canonical
 * ID + the explanatory note. Snippet body is admin-only — a follow-on
 * wave can pipe pack body into the session envelope and surface it
 * here. Until then, the hover-card teaches the user that the
 * highlighted token is a verifiable citation, even without the body.
 *
 * Visual: small `[1]`-style superscript pill (numbered by occurrence
 * order within the message via the `index` prop), tinted with the
 * brand primary colour so it stands out from inline code spans
 * without being distracting. The original backticked pack ID is
 * preserved inside the trigger's hover-card so users can copy / verify
 * the canonical name.
 */
export interface CitationHoverCardProps {
  /** Canonical pack id, e.g. `marico-haircare-portfolio`. */
  packId: string;
  /**
   * 1-based occurrence index within the surrounding message. Rendered
   * as the superscript label (`[1]`, `[2]`, …). Two citations of the
   * same pack get the same number — the MarkdownRenderer dedupes by
   * packId when assigning indices.
   */
  index: number;
}

export function CitationHoverCard({ packId, index }: CitationHoverCardProps) {
  const label = formatCitationLabel(packId);
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <sup
          className="ml-0.5 cursor-help text-[10px] font-medium text-primary underline decoration-dotted underline-offset-2 hover:text-primary/80"
          data-citation-pack-id={packId}
        >
          [{index}]
        </sup>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={4}
        className="w-72"
      >
        <div className="space-y-2 text-sm">
          <div className="font-semibold text-foreground">{label}</div>
          <div className="text-xs text-muted-foreground">
            Domain pack citation
          </div>
          <div className="rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground">
            {packId}
          </div>
          <div className="text-xs text-muted-foreground">
            This claim is grounded in the{" "}
            <span className="font-mono">{packId}</span> domain context pack.
            See <span className="font-medium">Admin · Domain Context</span> for
            the full pack body.
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
