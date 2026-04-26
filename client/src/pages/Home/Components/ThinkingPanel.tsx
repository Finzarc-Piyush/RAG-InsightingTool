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
  Copy,
  GitBranch,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface ThinkingPanelProps {
  steps: ThinkingStep[];
  workbench: AgentWorkbenchEntry[];
  /** While true, panel starts expanded and latest activity is highlighted. */
  isStreaming: boolean;
  /** live = collapsible stream panel; archived = saved segment, starts collapsed. */
  variant?: "live" | "archived";
  /** W12: sub-questions the agent spawned during deep investigation. */
  spawnedSubQuestions?: string[];
}

function StepRow({ step }: { step: ThinkingStep }) {
  const icon =
    step.status === "completed" ? (
      <CheckCircle2 className="h-4 w-4 text-primary" />
    ) : step.status === "active" ? (
      <Loader2 className="h-4 w-4 animate-spin text-primary motion-reduce:animate-none" />
    ) : step.status === "error" ? (
      <AlertCircle className="h-4 w-4 text-destructive" />
    ) : (
      <Circle className="h-4 w-4 text-muted-foreground/50" />
    );

  const textColor =
    step.status === "completed"
      ? "text-muted-foreground"
      : step.status === "active"
        ? "font-medium text-primary"
        : step.status === "error"
          ? "text-destructive"
          : "text-muted-foreground/80";

  const pillClass =
    step.status === "completed"
      ? "border-border bg-muted/40"
      : step.status === "active"
        ? "border-primary/35 bg-primary/5 shadow-sm"
        : step.status === "error"
          ? "border-destructive/30 bg-destructive/5"
          : "border-border/80 bg-muted/20";

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs transition-all duration-200",
        pillClass,
        step.status === "active" ? "opacity-100 shadow-sm" : "opacity-80"
      )}
    >
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className={textColor}>{step.step}</div>
        {step.details && (
          <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap break-words">
            {step.details}
          </div>
        )}
      </div>
    </div>
  );
}

/** Workbench entry as a StepRow-style row (no separate heavy card / gradual reveal). */
function WorkbenchActivityRow({
  entry,
  isLatest,
}: {
  entry: AgentWorkbenchEntry;
  isLatest: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const code = entry.code ?? "";
  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  const flow = entry.kind === "flow_decision" ? entry.flowDecision : undefined;
  const isOverride = Boolean(flow?.overriddenBy);

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3 py-2 text-xs transition-all duration-200",
        flow
          ? isOverride
            ? "border-destructive/30 bg-destructive/5"
            : "border-primary/30 bg-primary/5"
          : "border-border/80 bg-muted/25",
        isLatest && "ring-1 ring-primary/20"
      )}
    >
      <div className="flex-shrink-0 mt-0.5">
        {flow ? (
          <GitBranch
            className={cn(
              "h-4 w-4",
              isOverride ? "text-destructive" : "text-primary"
            )}
          />
        ) : (
          <Circle className="h-4 w-4 text-primary/80" />
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-foreground/90 font-medium break-words">{entry.title}</div>
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              <span
                className={cn(
                  "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  flow
                    ? isOverride
                      ? "border-destructive/30 bg-destructive/10 text-destructive"
                      : "border-primary/30 bg-primary/10 text-primary"
                    : "border-border/80 bg-muted/40 text-muted-foreground"
                )}
              >
                {flow ? flow.layer : entry.kind}
              </span>
              {flow && (
                <span className="inline-flex rounded-full border border-border/80 bg-card px-2 py-0.5 text-[10px] font-medium text-foreground/80">
                  → {flow.chosen}
                </span>
              )}
              {flow?.overriddenBy && (
                <span
                  className="inline-flex rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
                  title={flow.reason ?? undefined}
                >
                  overridden by {flow.overriddenBy}
                </span>
              )}
              {typeof flow?.confidence === "number" && (
                <span className="inline-flex rounded-full border border-border/80 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {(flow.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={copy}
            className="flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Copy to clipboard"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
        {copied && (
          <div className="text-[10px] text-primary">Copied</div>
        )}
        {code.length > 0 && (
          <pre
            className={cn(
              "text-[10px] leading-relaxed p-2 rounded-lg overflow-x-auto max-h-48 overflow-y-auto",
              "text-muted-foreground font-mono whitespace-pre-wrap break-words",
              "border border-border/80 bg-muted/50"
            )}
          >
            {code}
          </pre>
        )}
      </div>
    </div>
  );
}

export function ThinkingPanel({
  steps,
  workbench,
  isStreaming,
  variant = "live",
  spawnedSubQuestions = [],
}: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);
  const prevStreaming = useRef(false);

  useEffect(() => {
    if (variant === "archived") {
      return;
    }
    if (isStreaming) {
      // W10 · on mobile (<768px) the thinking panel dominates the viewport
      // and pushes the answer off-screen. Keep it collapsed; the user can
      // tap the trigger to inspect the live trace.
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

  const stepMap = new Map<string, ThinkingStep>();
  const stepOrder: string[] = [];
  for (const step of steps) {
    const stepKey = String(step.step);
    if (!stepMap.has(stepKey)) {
      stepMap.set(stepKey, step);
      stepOrder.push(stepKey);
    } else {
      const existing = stepMap.get(stepKey)!;
      if (step.timestamp > existing.timestamp) {
        stepMap.set(stepKey, step);
      }
    }
  }

  const totalItems = stepOrder.length + workbench.length;
  const subQCount = spawnedSubQuestions.length;
  const summary =
    totalItems > 0 || subQCount > 0
      ? `${totalItems} activit${totalItems === 1 ? "y" : "ies"}${subQCount > 0 ? ` · ${subQCount} sub-question${subQCount === 1 ? "" : "s"}` : ""}`
      : "Details";

  const lastWorkbenchIdx = workbench.length - 1;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="mt-3 ml-11"
      // UX-8 · announce live thinking so screen readers know work is in flight.
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
          // UX-8 · gentle breathe while the agent is actively streaming — a
          // subtle, honest "still working" cue. Neutralised by the global
          // prefers-reduced-motion guard on `.animate-brand-breathe`.
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
          <span className="text-foreground">Thinking</span>
          <span className="block text-[10px] font-normal text-muted-foreground mt-0.5 truncate">
            {summary}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4 overflow-hidden">
        {(stepOrder.length > 0 || workbench.length > 0) && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Activity
            </div>
            <div className="space-y-1.5">
              {stepOrder.map((name) => (
                <StepRow key={name} step={stepMap.get(name)!} />
              ))}
              {workbench.map((entry, idx) => (
                <WorkbenchActivityRow
                  key={entry.id}
                  entry={entry}
                  isLatest={isStreaming && idx === lastWorkbenchIdx}
                />
              ))}
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
              {spawnedSubQuestions.map((q, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground/80"
                >
                  <GitBranch className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary/60" />
                  <span>{q}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
