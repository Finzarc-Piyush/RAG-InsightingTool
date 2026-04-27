/**
 * W26 · PriorInvestigationsBanner
 *
 * Surfaces the W21 `priorInvestigations` digest as a collapsed pill above
 * the chat message list, so the user sees what the agent already knows
 * about this session before they ask their next question. Click to expand
 * → ordered list of prior turns with question, status pills, and headline
 * finding.
 *
 * Hidden entirely when the digest is empty or absent (legacy chats render
 * unchanged).
 *
 * Design choices:
 *   - Collapsed-by-default: keeps the chat header lean; the count chip
 *     answers "is there carry-over?" without expanding.
 *   - Includes the latest entry: there's minor visual duplication with the
 *     latest message's W13 InvestigationSummaryCard, but only when the
 *     user explicitly expands this banner. The trade-off favours
 *     dedup-on-the-data-not-the-render simplicity.
 *   - Semantic tokens only (per client/THEMING.md): bg-card, bg-muted/30,
 *     bg-primary/10, text-foreground, text-muted-foreground, text-primary,
 *     border-border. No raw hex / Tailwind palette literals.
 */
import { useState } from "react";
import type { SessionAnalysisContext } from "@/shared/schema";
import {
  ChevronDown,
  ChevronRight,
  BookOpenCheck,
  CheckCircle2,
  XCircle,
  CircleDashed,
} from "lucide-react";

interface PriorInvestigationsBannerProps {
  sessionAnalysisContext: SessionAnalysisContext | undefined;
  /** Default open state. Defaults to false (the banner is opt-in detail). */
  defaultOpen?: boolean;
}

type PriorEntry = NonNullable<
  SessionAnalysisContext["sessionKnowledge"]["priorInvestigations"]
>[number];

export function PriorInvestigationsBanner({
  sessionAnalysisContext,
  defaultOpen = false,
}: PriorInvestigationsBannerProps) {
  const [open, setOpen] = useState(defaultOpen);
  const prior =
    sessionAnalysisContext?.sessionKnowledge?.priorInvestigations ?? [];
  if (prior.length === 0) return null;

  const totalConfirmed = prior.reduce((n, p) => n + (p.hypothesesConfirmed?.length ?? 0), 0);
  const totalRefuted = prior.reduce((n, p) => n + (p.hypothesesRefuted?.length ?? 0), 0);
  const totalOpen = prior.reduce((n, p) => n + (p.hypothesesOpen?.length ?? 0), 0);

  return (
    <section
      className="mx-auto mb-2 w-full max-w-3xl rounded-brand-md border border-border/60 bg-card"
      aria-label="What we already learned in this session"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-brand-md px-4 py-2 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
        aria-controls="prior-investigations-body"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <BookOpenCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">
            What we already learned in this session
          </span>
          <span className="shrink-0 rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {prior.length} earlier turn{prior.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
          {totalConfirmed > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <CheckCircle2 className="h-3 w-3 text-primary" aria-hidden />
              {totalConfirmed} confirmed
            </span>
          )}
          {totalRefuted > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <XCircle className="h-3 w-3 text-destructive" aria-hidden />
              {totalRefuted} refuted
            </span>
          )}
          {totalOpen > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <CircleDashed className="h-3 w-3 text-muted-foreground" aria-hidden />
              {totalOpen} open
            </span>
          )}
        </span>
      </button>
      {open && (
        <ol
          id="prior-investigations-body"
          className="space-y-2 px-4 pb-3 pt-1"
        >
          {prior.map((p, i) => (
            <PriorEntryRow key={`${p.at}-${i}`} entry={p} index={i + 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

function PriorEntryRow({ entry, index }: { entry: PriorEntry; index: number }) {
  const hasHyps =
    (entry.hypothesesConfirmed?.length ?? 0) +
      (entry.hypothesesRefuted?.length ?? 0) +
      (entry.hypothesesOpen?.length ?? 0) >
    0;
  return (
    <li className="rounded-md border border-border/40 bg-muted/20 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <span
          className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary"
          aria-hidden
        >
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-snug text-foreground">
            {entry.question}
          </p>
          {entry.headlineFinding && (
            <p className="mt-1 text-[12px] italic leading-snug text-muted-foreground">
              {entry.headlineFinding}
            </p>
          )}
          {hasHyps && (
            <ul className="mt-1.5 space-y-0.5 text-[12px] leading-snug">
              {entry.hypothesesConfirmed?.map((h, k) => (
                <li
                  key={`c-${k}`}
                  className="flex items-start gap-1.5 text-foreground"
                >
                  <CheckCircle2
                    className="mt-0.5 h-3 w-3 shrink-0 text-primary"
                    aria-hidden
                  />
                  <span>{h}</span>
                </li>
              ))}
              {entry.hypothesesRefuted?.map((h, k) => (
                <li
                  key={`r-${k}`}
                  className="flex items-start gap-1.5 text-foreground"
                >
                  <XCircle
                    className="mt-0.5 h-3 w-3 shrink-0 text-destructive"
                    aria-hidden
                  />
                  <span>{h}</span>
                </li>
              ))}
              {entry.hypothesesOpen?.map((h, k) => (
                <li
                  key={`o-${k}`}
                  className="flex items-start gap-1.5 text-muted-foreground"
                >
                  <CircleDashed
                    className="mt-0.5 h-3 w-3 shrink-0"
                    aria-hidden
                  />
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}
