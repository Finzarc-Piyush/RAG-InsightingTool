import { useEffect, useRef, useState } from "react";
import {
  AgentWorkbenchEntry,
  ThinkingStep,
} from "@/shared/schema";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  GitBranch,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useRotatingMessage } from "@/hooks/useRotatingMessage";
import { DASHBOARD_BUILD_MESSAGES } from "./dashboardBuildMessages";
import { FeedbackButtons } from "./FeedbackButtons";
import type { Feedback, FeedbackTarget } from "@/lib/api/feedback";

interface ThinkingPanelProps {
  steps: ThinkingStep[];
  /** Kept on the signature for backwards compatibility with callers; not displayed. */
  workbench: AgentWorkbenchEntry[];
  /** While true, panel starts expanded and latest activity is highlighted. */
  isStreaming: boolean;
  /** live = collapsible stream panel; archived = saved segment, starts collapsed. */
  variant?: "live" | "archived";
  spawnedSubQuestions?: { id: string; question: string }[];
  /** Which spawned sub-questions have been investigated (id → chart count). */
  investigatedSubQuestions?: Record<string, { chartCount: number }>;
  sessionId?: string | null;
  turnId?: string | null;
  readOnly?: boolean;
  spawnedQuestionFeedback?: Record<string, { feedback: Feedback; comment?: string }>;
}

const GENERIC_WITTY_LABEL = "Working some magic…";

// The server brackets the long post-answer dashboard-build phase with this
// step (agentLoop.service.ts). The panel turns the matching pill into a live
// rotating status (DASHBOARD_BUILD_MESSAGES) so the ~1 min doesn't sit silent.
const DASHBOARD_BUILDING_STEP = "Building dashboard";
const DASHBOARD_BUILDING_LABEL = "Assembling your dashboard…";

function wittyLabelFor(rawStep: string): string {
  const step = rawStep.trim();
  if (/^Running tool:/i.test(step)) return "Crunching the numbers…";
  switch (step) {
    case DASHBOARD_BUILDING_STEP:
      return DASHBOARD_BUILDING_LABEL;
    case "Mapping columns from schema":
      return "Eyeballing the columns…";
    case "Analyzing user intent":
      return "Decoding what you actually meant…";
    case "Detecting query type":
      return "Sussing out the angle here…";
    case "Loading dataset":
      return "Cracking open the dataset…";
    case "Generating hypotheses":
      return "Floating a few theories…";
    case "Drafting analysis brief & hypotheses":
      return "Drawing up the case file…";
    case "Running investigation pre-planner":
      return "Casing the data before I dig in…";
    case "Retrieving session context":
      return "Flipping back through our chat…";
    case "Agent plan":
      return "Plotting the route…";
    case "Planning approach":
      return "Picking the sharpest angle of attack…";
    case "Synthesizing answer":
      return "Stitching it all together…";
    case "Reviewing answer":
      return "Marking my own homework…";
    default:
      return GENERIC_WITTY_LABEL;
  }
}

function StepRow({ label, status }: { label: string; status: ThinkingStep["status"] }) {
  const icon =
    status === "completed" ? (
      <CheckCircle2 className="h-4 w-4 text-primary" />
    ) : status === "active" ? (
      <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
    ) : status === "error" ? (
      <AlertCircle className="h-4 w-4 text-destructive" />
    ) : (
      <Circle className="h-4 w-4 text-muted-foreground/50" />
    );

  const textColor =
    status === "completed"
      ? "text-muted-foreground"
      : status === "active"
        ? "font-medium text-primary"
        : status === "error"
          ? "text-destructive"
          : "text-muted-foreground/80";

  const pillClass =
    status === "completed"
      ? "border-border bg-muted/40"
      : status === "active"
        ? "border-primary/35 bg-primary/5 shadow-sm"
        : status === "error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border/80 bg-muted/20";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs transition-all duration-200",
        pillClass,
        status === "active" ? "opacity-100 shadow-sm" : "opacity-80"
      )}
    >
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className={textColor}>{label}</div>
      </div>
    </div>
  );
}

/** The live, rotating witty line shown under the "Building dashboard" pill. */
function DashboardBuildingTicker({ line }: { line: string }) {
  return (
    <div className="ml-6 min-h-[1.1rem] text-[11px] italic leading-relaxed text-primary/80">
      <AnimatePresence mode="wait">
        <motion.div
          key={line}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={{ duration: 0.3 }}
        >
          {line}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

export function ThinkingPanel({
  steps,
  isStreaming,
  variant = "live",
  spawnedSubQuestions = [],
  investigatedSubQuestions = {},
  sessionId,
  turnId,
  readOnly = false,
  spawnedQuestionFeedback,
}: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);
  const prevStreaming = useRef(false);
  // Open the rotating dashboard-build status on a per-mount random line so two
  // builds don't always start on the same quip.
  const [tickerStart] = useState(() =>
    Math.floor(Math.random() * DASHBOARD_BUILD_MESSAGES.length)
  );

  useEffect(() => {
    if (variant === "archived") {
      return;
    }
    if (isStreaming) {
      const isMobile =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 767px)").matches;
      setOpen(!isMobile);
    } else if (prevStreaming.current) {
      setOpen(false);
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming, variant]);

  // Dedupe by witty label so two server-side phases that map to the same
  // user-facing message collapse into one row, with the latest timestamp
  // wins for status.
  const labelMap = new Map<string, { label: string; status: ThinkingStep["status"]; timestamp: number }>();
  const labelOrder: string[] = [];
  for (const step of steps) {
    const label = wittyLabelFor(String(step.step));
    const existing = labelMap.get(label);
    if (!existing) {
      labelMap.set(label, { label, status: step.status, timestamp: step.timestamp });
      labelOrder.push(label);
    } else if (step.timestamp > existing.timestamp) {
      labelMap.set(label, { label, status: step.status, timestamp: step.timestamp });
    }
  }

  // While the dashboard-build pill is active and the turn is still streaming,
  // play the rotating witty status both under the pill and in the (possibly
  // collapsed) header summary — so the user sees movement even on mobile.
  const buildEntry = labelMap.get(DASHBOARD_BUILDING_LABEL);
  const buildingActive =
    variant === "live" && isStreaming && buildEntry?.status === "active";
  const buildLine = useRotatingMessage(DASHBOARD_BUILD_MESSAGES, {
    enabled: buildingActive,
    startIndex: tickerStart,
  });

  const stepCount = labelOrder.length;
  const subQCount = spawnedSubQuestions.length;
  const summary =
    stepCount > 0 || subQCount > 0
      ? `${stepCount} step${stepCount === 1 ? "" : "s"}${subQCount > 0 ? ` · ${subQCount} sub-question${subQCount === 1 ? "" : "s"}` : ""}`
      : "Details";

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-3 ml-11"
      aria-busy={variant === "live" && isStreaming ? true : undefined}
      aria-live={variant === "live" ? "polite" : undefined}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-brand-lg border px-4 py-2.5 text-left",
          "border-border/80 bg-gradient-to-r from-primary/10 via-background to-primary/5",
          "backdrop-blur supports-[backdrop-filter]:bg-background/60",
          "hover:border-primary/20 transition-all duration-base ease-standard text-xs font-semibold text-foreground/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background shadow-elev-1 hover:shadow-elev-2",
          variant === "live" && isStreaming && "animate-brand-breathe"
        )}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
        <span className="flex-1 min-w-0">
          <span className="text-foreground">
            {buildingActive ? "Building dashboard" : "Thinking"}
          </span>
          <span className="block text-[10px] font-normal text-muted-foreground mt-0.5 truncate">
            {buildingActive ? (
              <AnimatePresence mode="wait">
                <motion.span
                  key={buildLine}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="text-primary/80"
                >
                  {buildLine}
                </motion.span>
              </AnimatePresence>
            ) : (
              summary
            )}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4 overflow-hidden">
        {labelOrder.length > 0 && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Progress
            </div>
            <div className="space-y-1.5">
              {labelOrder.map((label) => {
                const entry = labelMap.get(label)!;
                const showTicker =
                  buildingActive && label === DASHBOARD_BUILDING_LABEL;
                return (
                  <div key={label} className="space-y-1.5">
                    <StepRow label={entry.label} status={entry.status} />
                    {showTicker && <DashboardBuildingTicker line={buildLine} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {spawnedSubQuestions.length > 0 && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              Investigating further
            </div>
            <div className="space-y-1">
              {spawnedSubQuestions.map((q) => {
                const fb = spawnedQuestionFeedback?.[q.id];
                const target: FeedbackTarget = { type: "subanswer", id: q.id };
                const investigated = investigatedSubQuestions[q.id];
                return (
                  <div
                    key={q.id}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs text-foreground/80",
                      investigated
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-primary/20 bg-primary/5"
                    )}
                  >
                    {investigated ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500/70" />
                    ) : (
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                    )}
                    <span className="flex-1 min-w-0">{q.question}</span>
                    {investigated && (
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                        {investigated.chartCount > 0
                          ? `Investigated · ${investigated.chartCount} chart${investigated.chartCount === 1 ? "" : "s"}`
                          : "Investigated"}
                      </span>
                    )}
                    {sessionId && turnId && (
                      <FeedbackButtons
                        sessionId={sessionId}
                        turnId={turnId}
                        target={target}
                        layout="inline-right"
                        disabled={readOnly}
                        initial={fb?.feedback ?? "none"}
                        initialComment={fb?.comment ?? ""}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
