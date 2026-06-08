/**
 * W13 · InvestigationSummaryCard
 *
 * Renders the compact blackboard digest persisted on the assistant message:
 *   - Hypotheses tested (with status pills)
 *   - Headline findings (with significance dot)
 *   - Unresolved open questions (with priority dot)
 *
 * This is the single highest-leverage UX surface for "this analysis was
 * actually investigated, not just queried" — Excel/PowerBI AI surfaces tool
 * output but never the *why we ran it* or *what it ruled out*. The card sits
 * at the very top of the assistant bubble's analytical body so it primes the
 * reader before they hit findings or pivots.
 *
 * Hidden when no signals are present (legacy turns or pure descriptive
 * questions where no hypotheses were generated).
 *
 * Styling uses semantic tokens only (per client/THEMING.md): bg-card,
 * bg-muted/30, bg-primary/10, text-foreground, text-muted-foreground,
 * border-border, text-primary, text-destructive. No raw hex / palette
 * literals.
 */
import { useState } from "react";
import type { InvestigationSummary } from "@/shared/schema";
import {
  ChevronDown,
  ChevronRight,
  Microscope,
  CheckCircle2,
  XCircle,
  CircleDashed,
  CircleDot,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface InvestigationSummaryCardProps {
  summary: InvestigationSummary | undefined;
  defaultOpen?: boolean;
  onSuggestedQuestionClick?: (question: string) => void;
}

type Status = NonNullable<InvestigationSummary["hypotheses"]>[number]["status"];
type Priority = NonNullable<InvestigationSummary["openQuestions"]>[number]["priority"];

const STATUS_LABEL: Record<Status, string> = {
  open: "Open",
  confirmed: "Confirmed",
  refuted: "Refuted",
  partial: "Partial",
};

const STATUS_TONE: Record<Status, string> = {
  confirmed: "border-primary/40 bg-primary/10 text-primary",
  refuted: "border-destructive/40 bg-destructive/10 text-destructive",
  partial: "border-border bg-muted/40 text-foreground",
  open: "border-border bg-muted/20 text-muted-foreground",
};

function statusIcon(status: Status) {
  if (status === "confirmed") return <CheckCircle2 className="h-3 w-3" aria-hidden />;
  if (status === "refuted") return <XCircle className="h-3 w-3" aria-hidden />;
  if (status === "partial") return <CircleDot className="h-3 w-3" aria-hidden />;
  return <CircleDashed className="h-3 w-3" aria-hidden />;
}

const PRIORITY_DOT: Record<Priority, string> = {
  high: "bg-destructive",
  medium: "bg-primary",
  low: "bg-muted-foreground/40",
};

export function InvestigationSummaryCard({
  summary,
  defaultOpen = true,
  onSuggestedQuestionClick,
}: InvestigationSummaryCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (!summary) return null;
  const hyps = summary.hypotheses ?? [];
  const opens = summary.openQuestions ?? [];
  // UX · the raw "Findings" list (often internal tool names like
  // "run_breakdown_ranking:") was removed; only hypotheses + open questions
  // surface here now, so gate visibility on those.
  if (hyps.length === 0 && opens.length === 0) return null;

  // Counters for the collapsed-state header so the user can scan totals
  // without expanding the card.
  const confirmed = hyps.filter((h) => h.status === "confirmed").length;
  const refuted = hyps.filter((h) => h.status === "refuted").length;

  return (
    <section
      className="mb-3 rounded-brand-md border border-border/60 bg-card"
      aria-label="Investigation summary"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-brand-md px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
        aria-expanded={open}
        aria-controls="investigation-summary-body"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          <Microscope className="h-4 w-4 text-primary" aria-hidden />
          Investigation summary
        </span>
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {hyps.length > 0 && (
            <span>
              {hyps.length} hypothes{hyps.length === 1 ? "is" : "es"}
              {confirmed + refuted > 0
                ? ` · ${confirmed} confirmed${refuted > 0 ? `, ${refuted} refuted` : ""}`
                : ""}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div id="investigation-summary-body" className="space-y-3 px-4 pb-3">
          {hyps.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Hypotheses tested
              </p>
              <ul className="space-y-1.5">
                {hyps.map((h, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2"
                  >
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[h.status]}`}
                    >
                      {statusIcon(h.status)}
                      {STATUS_LABEL[h.status]}
                    </span>
                    <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-foreground">
                      {h.text}
                      {h.evidenceCount > 0 && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          ({h.evidenceCount} ref{h.evidenceCount === 1 ? "" : "s"})
                        </span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {opens.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Open questions
              </p>
              {onSuggestedQuestionClick ? (
                <div className="flex flex-wrap gap-2">
                  {opens.map((q, i) => (
                    <Button
                      key={i}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs rounded-full h-auto py-1.5 px-3 whitespace-normal break-words text-left max-w-full"
                      aria-label={`Investigate: ${q.question}`}
                      onClick={() => onSuggestedQuestionClick(q.question)}
                    >
                      {q.question}
                    </Button>
                  ))}
                </div>
              ) : (
                <ul className="space-y-1">
                  {opens.map((q, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-[12.5px] leading-snug text-foreground"
                    >
                      <span
                        className={`mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[q.priority]}`}
                        aria-label={`Priority: ${q.priority}`}
                      />
                      <span>{q.question}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
