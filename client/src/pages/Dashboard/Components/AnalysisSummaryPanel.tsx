/**
 * DPF4 · render the persisted analytical content (TL;DR, findings,
 * implications, recommendations, methodology, caveats, domainLens,
 * businessActions, investigationSummary, followUpPrompts) as visible
 * tiles in the live dashboard view.
 *
 * Pre-DPF4 these fields were stored on the dashboard but rendered ONLY in
 * the PPT export — opening a dashboard in the browser showed less content
 * than the chat surface that produced it. The user reported "not everything
 * gets pushed to the dashboard"; in practice most content WAS pushed but
 * was invisible.
 *
 * Placement: below CapturedFilterBanner and above the sheet/grid split,
 * so it's always visible regardless of which sheet is active. Each
 * subsection is independently gated on presence of its data and
 * collapsible — empty dashboards stay clean, busy dashboards stay tidy.
 *
 * Reuses `BusinessActionsCard` from the chat surface so the visual
 * contract for action items stays identical across chat and dashboard.
 *
 * Styling: semantic tokens only (per client/THEMING.md).
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Lightbulb,
  Compass,
  ListChecks,
  ScrollText,
  Microscope,
  ShieldAlert,
  HelpCircle,
} from "lucide-react";
import type {
  DashboardAnswerEnvelope,
  InvestigationSummary,
  PriorInvestigationItem,
  BusinessActionItem,
} from "@/shared/schema";
import { Button } from "@/components/ui/button";
import { BusinessActionsCard } from "@/pages/Home/Components/BusinessActionsCard";

interface AnalysisSummaryPanelProps {
  envelope?: DashboardAnswerEnvelope;
  businessActions?: BusinessActionItem[];
  followUpPrompts?: string[];
  investigationSummary?: InvestigationSummary;
  priorInvestigationsSnapshot?: PriorInvestigationItem[];
  question?: string;
}

const HORIZON_LABEL = {
  now: "Now",
  this_quarter: "This quarter",
  strategic: "Strategic",
} as const;

type RecommendationHorizon = keyof typeof HORIZON_LABEL;

function CollapsibleSection({
  title,
  Icon,
  children,
  defaultOpen = true,
  meta,
}: {
  title: string;
  Icon: typeof Sparkles;
  children: React.ReactNode;
  defaultOpen?: boolean;
  meta?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-brand-md border border-border bg-card">
      <Button
        type="button"
        variant="ghost"
        className="w-full justify-between rounded-t-brand-md px-4 py-3 hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {meta ? (
            <span className="text-xs text-muted-foreground">· {meta}</span>
          ) : null}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </Button>
      {open ? <div className="px-4 pb-4 pt-1">{children}</div> : null}
    </section>
  );
}

function FindingsList({
  findings,
}: {
  findings: NonNullable<DashboardAnswerEnvelope["findings"]>;
}) {
  return (
    <ul className="space-y-3">
      {findings.map((f, i) => (
        <li
          key={`finding-${i}`}
          className="rounded-brand-sm border border-border bg-background px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-medium text-foreground">{f.headline}</div>
            {f.magnitude ? (
              <span className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {f.magnitude}
              </span>
            ) : null}
          </div>
          {f.evidence ? (
            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
              {f.evidence}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ImplicationsList({
  implications,
}: {
  implications: NonNullable<DashboardAnswerEnvelope["implications"]>;
}) {
  return (
    <ul className="space-y-2">
      {implications.map((imp, i) => (
        <li
          key={`imp-${i}`}
          className="rounded-brand-sm border border-border bg-muted/20 px-3 py-2"
        >
          <div className="text-sm text-foreground">{imp.statement}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">So what:</span>{" "}
            {imp.soWhat}
          </div>
          {imp.confidence ? (
            <span className="mt-1 inline-block rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {imp.confidence} confidence
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RecommendationsByHorizon({
  recommendations,
}: {
  recommendations: NonNullable<DashboardAnswerEnvelope["recommendations"]>;
}) {
  const byHorizon: Record<RecommendationHorizon, typeof recommendations> = {
    now: [],
    this_quarter: [],
    strategic: [],
  };
  for (const r of recommendations) {
    const h = (r.horizon ?? "now") as RecommendationHorizon;
    byHorizon[h].push(r);
  }
  const horizons: RecommendationHorizon[] = [
    "now",
    "this_quarter",
    "strategic",
  ];
  return (
    <div className="space-y-3">
      {horizons.map((h) => {
        const list = byHorizon[h];
        if (list.length === 0) return null;
        return (
          <div key={h}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {HORIZON_LABEL[h]}
            </div>
            <ul className="mt-1 space-y-2">
              {list.map((r, i) => (
                <li
                  key={`rec-${h}-${i}`}
                  className="rounded-brand-sm border border-border bg-background px-3 py-2"
                >
                  <div className="text-sm font-medium text-foreground">
                    {r.action}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {r.rationale}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function InvestigationSummaryCard({
  summary,
}: {
  summary: InvestigationSummary;
}) {
  const hasContent =
    (summary.hypotheses?.length ?? 0) > 0 ||
    (summary.findings?.length ?? 0) > 0 ||
    (summary.openQuestions?.length ?? 0) > 0;
  if (!hasContent) return null;
  return (
    <div className="space-y-3 text-sm">
      {summary.hypotheses?.length ? (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Hypotheses
          </div>
          <ul className="mt-1 space-y-1">
            {summary.hypotheses.map((h, i) => (
              <li key={`hyp-${i}`} className="text-foreground">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {h.status}
                </span>{" "}
                · {h.text}
                {h.evidenceCount > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    ({h.evidenceCount} evidence)
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.findings?.length ? (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Findings
          </div>
          <ul className="mt-1 space-y-1">
            {summary.findings.map((f, i) => (
              <li key={`f-${i}`} className="text-foreground">
                {f.label}
                <span className="text-xs text-muted-foreground"> · {f.significance}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.openQuestions?.length ? (
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Open questions
          </div>
          <ul className="mt-1 space-y-1">
            {summary.openQuestions.map((q, i) => (
              <li key={`q-${i}`} className="text-foreground">
                {q.question}
                <span className="text-xs text-muted-foreground">
                  {" "}
                  · {q.priority} priority
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PriorInvestigationsList({
  items,
}: {
  items: PriorInvestigationItem[];
}) {
  return (
    <ul className="space-y-2 text-sm">
      {items.map((item, i) => (
        <li
          key={`prior-${i}`}
          className="rounded-brand-sm border border-border bg-muted/20 px-3 py-2"
        >
          <div className="text-xs text-muted-foreground">{item.at}</div>
          <div className="text-foreground">{item.question}</div>
          {item.headlineFinding ? (
            <div className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Finding:</span>{" "}
              {item.headlineFinding}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function AnalysisSummaryPanel(props: AnalysisSummaryPanelProps) {
  const {
    envelope,
    businessActions,
    followUpPrompts,
    investigationSummary,
    priorInvestigationsSnapshot,
    question,
  } = props;

  const hasEnvelope =
    !!envelope &&
    (envelope.tldr ||
      (envelope.findings?.length ?? 0) > 0 ||
      (envelope.implications?.length ?? 0) > 0 ||
      (envelope.recommendations?.length ?? 0) > 0 ||
      envelope.methodology ||
      (envelope.caveats?.length ?? 0) > 0 ||
      envelope.domainLens);
  const hasBusinessActions = (businessActions?.length ?? 0) > 0;
  const hasFollowUps = (followUpPrompts?.length ?? 0) > 0;
  const hasInvestigation =
    !!investigationSummary &&
    ((investigationSummary.hypotheses?.length ?? 0) > 0 ||
      (investigationSummary.findings?.length ?? 0) > 0 ||
      (investigationSummary.openQuestions?.length ?? 0) > 0);
  const hasPrior = (priorInvestigationsSnapshot?.length ?? 0) > 0;

  if (
    !hasEnvelope &&
    !hasBusinessActions &&
    !hasFollowUps &&
    !hasInvestigation &&
    !hasPrior
  ) {
    return null;
  }

  return (
    <div
      className="space-y-3"
      aria-label="Analysis summary"
      data-testid="dashboard-analysis-summary-panel"
    >
      {/* TL;DR pill — always at the top when present */}
      {envelope?.tldr ? (
        <div className="flex items-start gap-2 rounded-brand-md border border-primary/40 bg-primary/5 px-4 py-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="text-sm text-foreground">
            <span className="font-semibold">TL;DR · </span>
            {envelope.tldr}
          </div>
        </div>
      ) : null}

      {question ? (
        <div className="text-xs text-muted-foreground italic">
          Original question: {question}
        </div>
      ) : null}

      {envelope?.domainLens ? (
        <div className="rounded-brand-sm border border-border bg-muted/20 px-3 py-2 text-sm italic text-muted-foreground">
          {envelope.domainLens}
        </div>
      ) : null}

      {envelope?.findings?.length ? (
        <CollapsibleSection
          title="Findings"
          Icon={Lightbulb}
          meta={`${envelope.findings.length}`}
        >
          <FindingsList findings={envelope.findings} />
        </CollapsibleSection>
      ) : null}

      {envelope?.implications?.length ? (
        <CollapsibleSection
          title="Implications"
          Icon={Compass}
          meta={`${envelope.implications.length}`}
          defaultOpen={false}
        >
          <ImplicationsList implications={envelope.implications} />
        </CollapsibleSection>
      ) : null}

      {envelope?.recommendations?.length ? (
        <CollapsibleSection
          title="Analytical recommendations"
          Icon={ListChecks}
          meta={`${envelope.recommendations.length}`}
        >
          <RecommendationsByHorizon recommendations={envelope.recommendations} />
        </CollapsibleSection>
      ) : null}

      {hasBusinessActions ? (
        <BusinessActionsCard items={businessActions!} />
      ) : null}

      {envelope?.methodology ? (
        <CollapsibleSection
          title="Methodology"
          Icon={ScrollText}
          defaultOpen={false}
        >
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {envelope.methodology}
          </p>
        </CollapsibleSection>
      ) : null}

      {envelope?.caveats?.length ? (
        <CollapsibleSection
          title="Caveats"
          Icon={ShieldAlert}
          meta={`${envelope.caveats.length}`}
          defaultOpen={false}
        >
          <ul className="space-y-1 text-sm text-muted-foreground italic">
            {envelope.caveats.map((c, i) => (
              <li key={`caveat-${i}`}>• {c}</li>
            ))}
          </ul>
        </CollapsibleSection>
      ) : null}

      {hasInvestigation ? (
        <CollapsibleSection
          title="How this was investigated"
          Icon={Microscope}
          defaultOpen={false}
        >
          <InvestigationSummaryCard summary={investigationSummary!} />
        </CollapsibleSection>
      ) : null}

      {hasPrior ? (
        <CollapsibleSection
          title="Prior investigations"
          Icon={HelpCircle}
          meta={`${priorInvestigationsSnapshot!.length}`}
          defaultOpen={false}
        >
          <PriorInvestigationsList items={priorInvestigationsSnapshot!} />
        </CollapsibleSection>
      ) : null}

      {hasFollowUps ? (
        <div className="rounded-brand-sm border border-border bg-muted/20 px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Suggested follow-ups
          </div>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {followUpPrompts!.map((p, i) => (
              <li key={`fup-${i}`}>· {p}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
