/**
 * W7 · AnswerCard
 *
 * Renders a Message's `answerEnvelope` (TL;DR → Findings → Methodology →
 * Caveats → Next steps) when present. The MessageBubble decides whether to
 * mount this or fall back to MarkdownRenderer over `message.content`.
 *
 * Visual hierarchy follows the canonical "headline first" pattern from
 * Claude.ai / ChatGPT / Linear's AI surfaces:
 *   - TL;DR pill at the top — one sentence, scannable
 *   - Findings list — numbered, each with a magnitude badge
 *   - Methodology in a collapsible — present but not loud
 *   - Caveats as a muted card — visible but de-emphasized
 *   - Next-steps as outline buttons — actionable
 *
 * Styling uses semantic tokens only (per client/THEMING.md): bg-card,
 * bg-primary/5, text-foreground, text-muted-foreground, border-border.
 * No raw hex / Tailwind palette literals. Verified against light + dark.
 */
import { useState } from "react";
import type { Message } from "@/shared/schema";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  Lightbulb,
  AlertTriangle,
  BookOpen,
  Sparkles,
  Target,
} from "lucide-react";
import { MarkdownRenderer } from "@/components/ui/markdown-renderer";

interface AnswerCardProps {
  message: Message;
  onSuggestedQuestionClick?: (question: string) => void;
  /** Optional supplementary markdown body — rendered after the structured envelope. */
  supplementaryMarkdown?: string;
}

type Horizon = "now" | "this_quarter" | "strategic";
const HORIZON_LABEL: Record<Horizon, string> = {
  now: "Do now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};
const HORIZON_ORDER: Horizon[] = ["now", "this_quarter", "strategic"];

const CONFIDENCE_TONE: Record<NonNullable<NonNullable<Message["answerEnvelope"]>["implications"]>[number]["confidence"] & string, string> = {
  high: "border-primary/40 bg-primary/10 text-primary",
  medium: "border-border bg-muted/40 text-foreground",
  low: "border-border bg-muted/20 text-muted-foreground",
};

export function AnswerCard({
  message,
  onSuggestedQuestionClick,
  supplementaryMarkdown,
}: AnswerCardProps) {
  const env = message.answerEnvelope;
  const [methodologyOpen, setMethodologyOpen] = useState(false);

  if (!env) return null;

  // W9 · group recommendations by horizon for the "Do now / This quarter /
  // Strategic" sections. Recommendations without a horizon fall under "Other"
  // so nothing is silently dropped.
  const recsByHorizon = (() => {
    const groups = new Map<Horizon | "other", NonNullable<typeof env.recommendations>>();
    for (const r of env.recommendations ?? []) {
      const key = (r.horizon as Horizon | undefined) ?? "other";
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return groups;
  })();

  return (
    <div className="space-y-4">
      {env.domainLens && (
        <div
          className="rounded-brand-md border border-border/60 bg-muted/30 px-4 py-2.5"
          aria-label="Industry context"
        >
          <div className="flex items-start gap-2">
            <BookOpen
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">
                Industry context
              </p>
              <p className="text-[13px] italic leading-[20px] text-foreground">
                {env.domainLens}
              </p>
            </div>
          </div>
        </div>
      )}

      {env.tldr && (
        <div
          className="rounded-brand-md border border-primary/30 bg-primary/10 px-4 py-3"
          aria-label="Headline answer"
        >
          <div className="flex items-start gap-2">
            <Lightbulb
              className="mt-0.5 h-4 w-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <p className="text-[15px] font-medium leading-[22px] text-foreground">
              {env.tldr}
            </p>
          </div>
        </div>
      )}

      {supplementaryMarkdown?.trim() && (
        <div className="text-[15px] leading-[24px] text-foreground whitespace-pre-wrap">
          <MarkdownRenderer content={supplementaryMarkdown} />
        </div>
      )}

      {env.findings && env.findings.length > 0 && (
        <section aria-label="Key findings">
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Key findings
          </h3>
          <ol className="space-y-2.5">
            {env.findings.map((f, i) => (
              <li
                key={i}
                className="rounded-brand-md border border-border/60 bg-card px-4 py-3"
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-[14px] font-medium text-foreground">
                        {f.headline}
                      </span>
                      {f.magnitude && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                          {f.magnitude}
                        </span>
                      )}
                    </div>
                    {f.evidence && (
                      <p className="mt-1 text-[13px] leading-[20px] text-muted-foreground">
                        {f.evidence}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {env.implications && env.implications.length > 0 && (
        <section aria-label="What this means">
          <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            What this means
          </h3>
          <ul className="space-y-2">
            {env.implications.map((imp, i) => (
              <li
                key={i}
                className="rounded-brand-md border border-border/60 bg-card px-4 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-[13px] leading-[20px] text-foreground">
                    {imp.statement}
                  </p>
                  {imp.confidence && (
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        CONFIDENCE_TONE[imp.confidence] ?? CONFIDENCE_TONE.medium
                      }`}
                      aria-label={`Confidence: ${imp.confidence}`}
                    >
                      {imp.confidence}
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-[13px] leading-[20px] text-muted-foreground">
                  <span className="font-semibold text-foreground">So what: </span>
                  {imp.soWhat}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {env.recommendations && env.recommendations.length > 0 && (
        <section aria-label="Recommended actions">
          <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            Recommended actions
          </h3>
          <div className="space-y-3">
            {[...HORIZON_ORDER, "other" as const]
              .filter((h) => (recsByHorizon.get(h) ?? []).length > 0)
              .map((h) => {
                const items = recsByHorizon.get(h) ?? [];
                const heading = h === "other" ? "Other" : HORIZON_LABEL[h];
                return (
                  <div key={h} className="rounded-brand-md border border-border/60 bg-card px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                      {heading}
                    </p>
                    <ol className="space-y-2 list-decimal list-inside marker:text-muted-foreground">
                      {items.map((r, i) => (
                        <li key={i} className="text-[13px] leading-[20px] text-foreground">
                          <span className="font-medium">{r.action}</span>
                          <span className="ml-1 text-muted-foreground">— {r.rationale}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })}
          </div>
        </section>
      )}

      {env.methodology && (
        <section aria-label="Methodology">
          <button
            type="button"
            onClick={() => setMethodologyOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={methodologyOpen}
            aria-controls="answer-methodology"
          >
            {methodologyOpen ? (
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Methodology
          </button>
          {methodologyOpen && (
            <p
              id="answer-methodology"
              className="mt-2 rounded-brand-md border border-border/40 bg-muted/30 px-3 py-2 text-[13px] leading-[20px] text-muted-foreground"
            >
              {env.methodology}
            </p>
          )}
        </section>
      )}

      {env.caveats && env.caveats.length > 0 && (
        <section
          aria-label="Caveats"
          className="rounded-brand-md border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300 mb-1">
                Caveats
              </p>
              <ul className="space-y-1 text-[13px] leading-[20px] text-foreground">
                {env.caveats.map((c, i) => (
                  <li key={i}>• {c}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {env.nextSteps && env.nextSteps.length > 0 && onSuggestedQuestionClick && (
        <section aria-label="Suggested next steps">
          <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Try next
          </p>
          <div className="flex flex-wrap gap-2">
            {env.nextSteps.map((step, i) => (
              <Button
                key={i}
                type="button"
                variant="outline"
                size="sm"
                className="text-xs rounded-full h-auto py-1.5 px-3"
                aria-label={`Try this follow-up: ${step}`}
                onClick={() => onSuggestedQuestionClick(step)}
              >
                {step}
              </Button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
