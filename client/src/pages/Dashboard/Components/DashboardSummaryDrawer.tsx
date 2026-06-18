import { Sparkles } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  DashboardAnswerEnvelope,
  InvestigationSummary,
  PriorInvestigationItem,
  BusinessActionItem,
} from "@/shared/schema";
import { AnalysisSummaryPanel } from "./AnalysisSummaryPanel";

/**
 * Wave DR2 · summary drawer.
 *
 * Pre-DR2 the post-analysis content (TL;DR, findings, implications,
 * recommendations, business actions, methodology, caveats, prior
 * investigations) rendered above the canvas via `AnalysisSummaryPanel`,
 * pushing the actual charts below the fold even on first paint. The
 * drawer keeps the same content but reveals it on demand from a header
 * trigger so the canvas leads the page.
 *
 * Content is unchanged — this is a placement-only refactor. The panel
 * itself decides which sections to render based on what's populated;
 * it returns null when nothing is. The header therefore should also
 * hide the trigger when none of the summary fields exist.
 */

interface DashboardSummaryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  envelope?: DashboardAnswerEnvelope;
  businessActions?: BusinessActionItem[];
  followUpPrompts?: string[];
  investigationSummary?: InvestigationSummary;
  priorInvestigationsSnapshot?: PriorInvestigationItem[];
  /** IUX3 · click a suggested follow-up → send it to the source chat composer. */
  onSelectFollowUp?: (question: string) => void;
}

export function hasAnySummaryContent(
  props: Omit<DashboardSummaryDrawerProps, "open" | "onOpenChange">,
): boolean {
  const e = props.envelope;
  const hasEnvelope =
    !!e &&
    (!!e.tldr ||
      (e.findings?.length ?? 0) > 0 ||
      (e.implications?.length ?? 0) > 0 ||
      (e.recommendations?.length ?? 0) > 0 ||
      !!e.methodology ||
      (e.caveats?.length ?? 0) > 0 ||
      !!e.domainLens);
  const hasBusinessActions = (props.businessActions?.length ?? 0) > 0;
  const hasFollowUps = (props.followUpPrompts?.length ?? 0) > 0;
  const hasInvestigation =
    !!props.investigationSummary &&
    ((props.investigationSummary.hypotheses?.length ?? 0) > 0 ||
      (props.investigationSummary.findings?.length ?? 0) > 0 ||
      (props.investigationSummary.openQuestions?.length ?? 0) > 0);
  const hasPrior = (props.priorInvestigationsSnapshot?.length ?? 0) > 0;
  return (
    hasEnvelope ||
    hasBusinessActions ||
    hasFollowUps ||
    hasInvestigation ||
    hasPrior
  );
}

export function DashboardSummaryDrawer({
  open,
  onOpenChange,
  envelope,
  businessActions,
  followUpPrompts,
  investigationSummary,
  priorInvestigationsSnapshot,
  onSelectFollowUp,
}: DashboardSummaryDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] overflow-y-auto"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Analysis summary
          </SheetTitle>
          <SheetDescription>
            What the agent concluded — findings, implications,
            recommendations, business action items, and how this was
            investigated.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <AnalysisSummaryPanel
            envelope={envelope}
            businessActions={businessActions}
            followUpPrompts={followUpPrompts}
            investigationSummary={investigationSummary}
            priorInvestigationsSnapshot={priorInvestigationsSnapshot}
            onSelectFollowUp={onSelectFollowUp}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
