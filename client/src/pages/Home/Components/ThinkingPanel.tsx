import { useEffect, useMemo, useRef, useState } from "react";
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
  Clock,
  GitBranch,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useRotatingMessage } from "@/hooks/useRotatingMessage";
import {
  categoryForThinkingStep,
  pickWittyLine,
  startIndexFor,
  wittyPoolFor,
  type WittyCategory,
} from "./wittyCopy";
import { estimateAnswerBand, formatSeconds } from "./answerTimeEstimate";
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
  /** Epoch ms the turn started (isLoading rising edge). Drives the live timer. */
  startedAtMs?: number | null;
  spawnedQuestionFeedback?: Record<string, { feedback: Feedback; comment?: string }>;
}

// Witty per-step copy now lives in the shared, category-matched pool
// (./wittyCopy). The panel resolves each server step → a CATEGORY → a bank of
// candidate lines: a settled step shows one deterministically-picked line; the
// single active step rotates through its whole bank during the wait. The long
// dashboard-build phase ("Building dashboard") is just the `dashboard` category.

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

export function ThinkingPanel({
  steps,
  isStreaming,
  variant = "live",
  spawnedSubQuestions = [],
  investigatedSubQuestions = {},
  sessionId,
  turnId,
  readOnly = false,
  startedAtMs,
  spawnedQuestionFeedback,
}: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);
  const prevStreaming = useRef(false);

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

  // Dedupe by witty CATEGORY (not the now-varying label) so two server phases
  // in the same stage collapse into one row. Earliest timestamp is the stable
  // seed for the deterministic line; latest timestamp wins the status.
  const { catOrder, catMap } = useMemo(() => {
    const map = new Map<
      WittyCategory,
      { category: WittyCategory; status: ThinkingStep["status"]; seed: number; latestTs: number }
    >();
    const order: WittyCategory[] = [];
    for (const step of steps) {
      const category = categoryForThinkingStep(String(step.step));
      const existing = map.get(category);
      if (!existing) {
        map.set(category, { category, status: step.status, seed: step.timestamp, latestTs: step.timestamp });
        order.push(category);
      } else {
        if (step.timestamp < existing.seed) existing.seed = step.timestamp;
        if (step.timestamp >= existing.latestTs) {
          existing.latestTs = step.timestamp;
          existing.status = step.status;
        }
      }
    }
    return { catOrder: order, catMap: map };
  }, [steps]);

  // The single active step rotates through its whole bank during the wait, so a
  // long stage surfaces many of the witty lines — the dashboard build is simply
  // the `dashboard` category special case of this (header still says so below).
  let activeCategory: WittyCategory | null = null;
  for (const cat of catOrder) {
    if (catMap.get(cat)!.status === "active") activeCategory = cat;
  }
  const rotating = variant === "live" && isStreaming && activeCategory != null;
  const activeSeed = activeCategory != null ? catMap.get(activeCategory)!.seed : 0;
  const activeLine = useRotatingMessage(
    activeCategory != null ? wittyPoolFor(activeCategory) : wittyPoolFor("generic"),
    {
      enabled: rotating,
      startIndex: activeCategory != null ? startIndexFor(activeCategory, activeSeed) : 0,
    }
  );
  const buildingActive =
    variant === "live" && isStreaming && catMap.get("dashboard")?.status === "active";

  // Live "time to get an answer" timer (mirrors the enrichment loader's box):
  // elapsed since the turn started + a coarse "usually about X–Ys" band.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAtMs == null || variant !== "live" || !isStreaming) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAtMs, variant, isStreaming]);
  const { low: etaLow, high: etaHigh } = useMemo(
    () => estimateAnswerBand({ dashboardActive: catMap.has("dashboard"), stepCount: catOrder.length }),
    [catMap, catOrder.length]
  );
  const showTimer = variant === "live" && isStreaming && startedAtMs != null;
  const takingLong = elapsed > etaHigh * 1.5;

  const stepCount = catOrder.length;
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
            {rotating ? (
              <AnimatePresence mode="wait">
                <motion.span
                  key={activeLine}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="text-primary/80"
                >
                  {activeLine}
                </motion.span>
              </AnimatePresence>
            ) : (
              summary
            )}
          </span>
        </span>
        {showTimer && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/70 px-2 py-1 text-[10px] font-normal tabular-nums text-muted-foreground"
            title="Time so far · typical answer time"
          >
            <Clock className="h-3 w-3 text-muted-foreground/80" />
            <span className="text-foreground/90">{formatSeconds(elapsed)}</span>
            {takingLong ? (
              <span className="text-muted-foreground/70">· a little longer…</span>
            ) : (
              <span className="text-muted-foreground/60">
                / ~{etaLow}–{etaHigh}s
              </span>
            )}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4 overflow-hidden">
        {catOrder.length > 0 && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Progress
            </div>
            <div className="space-y-1.5">
              {catOrder.map((cat) => {
                const entry = catMap.get(cat)!;
                const isActiveRow = rotating && cat === activeCategory;
                const label = isActiveRow ? activeLine : pickWittyLine(cat, entry.seed);
                return (
                  <div key={cat} className="space-y-1.5">
                    <StepRow label={label} status={entry.status} />
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
