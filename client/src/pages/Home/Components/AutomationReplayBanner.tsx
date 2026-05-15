/**
 * Wave A15 · Sticky top banner shown during automation replay.
 *
 * Renders four states based on `phase`:
 *   - "preparing"   — spinner + "Preparing dataset…"
 *   - "replaying"   — progress bar + per-question detail + cancel button
 *   - "halted"      — red bar with skip / live-rerun / stop buttons
 *   - "complete"    — green bar with summary + dismiss
 */

import { Loader2, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

export type ReplayBannerPhase =
  | { kind: "preparing"; detail?: string }
  | {
      kind: "replaying";
      step: number;
      total: number;
      currentQuestion?: string;
    }
  | {
      kind: "halted";
      ordinal: number;
      error: string;
    }
  | {
      kind: "complete";
      questionsReplayed: number;
      dashboardsCreated: number;
    };

export interface AutomationReplayBannerProps {
  automationName: string;
  phase: ReplayBannerPhase;
  onCancel?: () => void;
  onDismiss?: () => void;
  onSkipAndContinue?: () => void;
  onRetryWithLiveAgent?: () => void;
  onStop?: () => void;
}

export const AutomationReplayBanner = ({
  automationName,
  phase,
  onCancel,
  onDismiss,
  onSkipAndContinue,
  onRetryWithLiveAgent,
  onStop,
}: AutomationReplayBannerProps) => {
  if (phase.kind === "preparing") {
    return (
      <div className="sticky top-0 z-40 border-b border-border bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">
              Preparing dataset for "{automationName}"
            </div>
            <div className="text-sm text-muted-foreground truncate">
              {phase.detail ?? "Re-applying schema transformations…"}
            </div>
          </div>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (phase.kind === "replaying") {
    const pct = Math.round((phase.step / Math.max(phase.total, 1)) * 100);
    return (
      <div className="sticky top-0 z-40 border-b border-border bg-card px-4 py-3 shadow-sm">
        <div className="flex items-center gap-3 mb-2">
          <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-foreground">
              Running "{automationName}"
            </div>
            <div className="text-sm text-muted-foreground truncate">
              Question {phase.step} of {phase.total}
              {phase.currentQuestion && ` · ${phase.currentQuestion}`}
            </div>
          </div>
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    );
  }

  if (phase.kind === "halted") {
    return (
      <div className="sticky top-0 z-40 border-b border-destructive/40 bg-destructive/10 px-4 py-3 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-destructive">
              Replay halted on question {phase.ordinal + 1}
            </div>
            <div className="text-sm text-muted-foreground mt-1">
              {phase.error}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {onSkipAndContinue && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onSkipAndContinue}
                >
                  Skip this question and continue
                </Button>
              )}
              {onRetryWithLiveAgent && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetryWithLiveAgent}
                >
                  Re-run this question with the live agent
                </Button>
              )}
              {onStop && (
                <Button variant="destructive" size="sm" onClick={onStop}>
                  Stop replay
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // complete
  return (
    <div className="sticky top-0 z-40 border-b border-emerald-300/60 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 shadow-sm">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Automation complete
          </div>
          <div className="text-sm text-muted-foreground mt-0.5">
            {phase.questionsReplayed} question
            {phase.questionsReplayed === 1 ? "" : "s"} replayed
            {phase.dashboardsCreated > 0 &&
              ` · ${phase.dashboardsCreated} dashboard${phase.dashboardsCreated === 1 ? "" : "s"} created`}
            . You can continue chatting freely.
          </div>
        </div>
        {onDismiss && (
          <Button variant="ghost" size="icon" onClick={onDismiss}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
};
