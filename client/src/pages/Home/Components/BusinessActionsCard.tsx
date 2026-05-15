/**
 * Renders `message.businessActions` — concrete business decisions the user
 * could take in the world, populated by the post-verifier
 * businessActionsAgent. Distinct from `answerEnvelope.recommendations`,
 * which are analytical next steps to run inside the app.
 *
 * Visual contract (from the plan):
 *   - Bordered, collapsible card, expanded by default. Mounted by
 *     MessageBubble alongside (not inside) AnswerCard so it renders even
 *     when the answer envelope is absent.
 *   - Flat ordered list, each row carries a horizon chip
 *     (Now / This quarter / Strategic) and a confidence chip
 *     (Low / Medium / High). Low-confidence chips read as tentative.
 *   - Subtitle clarifies "starting points, not conclusions".
 *   - When ANY action is low-confidence, a muted caveat row sits above
 *     the list nudging the user to validate before acting.
 *
 * Styling: semantic tokens only (per client/THEMING.md).
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Briefcase,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import type { Message } from "@/shared/schema";
import { Button } from "@/components/ui/button";

type BusinessAction = NonNullable<Message["businessActions"]>[number];
type Horizon = BusinessAction["horizon"];
type Confidence = BusinessAction["confidence"];

const HORIZON_LABEL: Record<Horizon, string> = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: "border-primary/40 bg-primary/10 text-primary",
  medium: "border-border bg-muted/50 text-foreground",
  low: "border-border bg-muted/30 text-muted-foreground",
};

const HORIZON_TONE: Record<Horizon, string> = {
  now: "border-primary/40 bg-primary/10 text-primary",
  this_quarter: "border-border bg-muted/50 text-foreground",
  strategic: "border-border bg-muted/40 text-muted-foreground",
};

interface BusinessActionsCardProps {
  items: BusinessAction[];
}

export function BusinessActionsCard({ items }: BusinessActionsCardProps) {
  const [open, setOpen] = useState(true);
  if (!items?.length) return null;

  const anyLow = items.some((i) => i.confidence === "low");

  return (
    <section
      aria-label="Business action items"
      className="mt-4 rounded-brand-md border border-border bg-card"
    >
      <Button
        type="button"
        variant="ghost"
        className="w-full justify-between rounded-t-brand-md px-4 py-3 hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <Briefcase className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-semibold text-foreground">
            Business action items
          </span>
          <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
            {items.length} suggested
          </span>
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
      </Button>
      {open && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Suggestions for business decisions, grounded in the findings above.
            These are starting points — not conclusions. Verify before acting.
          </p>
          {anyLow && (
            <div className="flex items-start gap-2 rounded-brand-md border border-border/60 bg-muted/30 px-3 py-2">
              <ShieldCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="text-xs text-muted-foreground">
                Some actions are flagged low-confidence because the supporting
                evidence is thin; treat these as hypotheses to validate, not
                directives.
              </p>
            </div>
          )}
          <ol className="space-y-3">
            {items.map((item, idx) => (
              <li
                key={idx}
                className="rounded-brand-md border border-border/60 bg-card px-3 py-2.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground">
                      {idx + 1}. {item.title}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {item.rationale}
                    </p>
                    {item.dependencies && (
                      <p className="mt-1 text-xs italic text-muted-foreground">
                        Dependencies: {item.dependencies}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${HORIZON_TONE[item.horizon]}`}
                    >
                      {HORIZON_LABEL[item.horizon]}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${CONFIDENCE_TONE[item.confidence]}`}
                      title={CONFIDENCE_LABEL[item.confidence]}
                    >
                      {item.confidence === "high"
                        ? "High"
                        : item.confidence === "medium"
                        ? "Medium"
                        : "Low"}
                    </span>
                  </div>
                </div>
                {item.expectedImpact && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Expected impact: {item.expectedImpact}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
