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
  Loader2,
} from "lucide-react";
import { useGradualReveal } from "@/hooks/useGradualReveal";
import { cn } from "@/lib/utils";

interface ThinkingPanelProps {
  steps: ThinkingStep[];
  workbench: AgentWorkbenchEntry[];
  /** While true, panel starts expanded and workbench blocks animate in. */
  isStreaming: boolean;
}

function WorkbenchBlock({
  entry,
  animate,
}: {
  entry: AgentWorkbenchEntry;
  animate: boolean;
}) {
  const revealed = useGradualReveal(entry.code, { active: animate });
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(entry.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-lg border border-zinc-700/80 bg-zinc-950/95 overflow-hidden shadow-inner">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/80">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-zinc-200 truncate">
            {entry.title}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono">{entry.kind}</div>
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex-shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          aria-label="Copy to clipboard"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      {copied && (
        <div className="px-3 py-1 text-[10px] text-emerald-400 bg-zinc-900/80 border-b border-zinc-800">
          Copied
        </div>
      )}
      <pre
        className={cn(
          "text-[11px] leading-relaxed p-3 overflow-x-auto max-h-64 overflow-y-auto",
          "text-zinc-200 font-mono whitespace-pre-wrap break-words"
        )}
      >
        {revealed}
        {animate && revealed.length < entry.code.length && (
          <span className="inline-block w-1.5 h-3 ml-0.5 bg-emerald-500/80 animate-pulse align-middle rounded-sm" />
        )}
      </pre>
    </div>
  );
}

function StepRow({ step }: { step: ThinkingStep }) {
  const icon =
    step.status === "completed" ? (
      <CheckCircle2 className="w-4 h-4 text-green-500" />
    ) : step.status === "active" ? (
      <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
    ) : step.status === "error" ? (
      <AlertCircle className="w-4 h-4 text-red-500" />
    ) : (
      <Circle className="w-4 h-4 text-gray-300" />
    );

  const textColor =
    step.status === "completed"
      ? "text-gray-600"
      : step.status === "active"
        ? "text-blue-600 font-medium"
        : step.status === "error"
          ? "text-red-600"
          : "text-gray-400";

  return (
    <div
      className={cn(
        "flex items-start gap-2 text-xs transition-opacity duration-200",
        step.status === "active" ? "opacity-100" : "opacity-80"
      )}
    >
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className={textColor}>{step.step}</div>
        {step.details && (
          <div className="text-xs text-gray-500 mt-0.5">{step.details}</div>
        )}
      </div>
    </div>
  );
}

export function ThinkingPanel({ steps, workbench, isStreaming }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false);
  const prevStreaming = useRef(false);

  useEffect(() => {
    if (isStreaming) {
      setOpen(true);
    } else if (prevStreaming.current) {
      setOpen(false);
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  const stepMap = new Map<string, ThinkingStep>();
  const stepOrder: string[] = [];
  for (const step of steps) {
    if (!stepMap.has(step.step)) {
      stepMap.set(step.step, step);
      stepOrder.push(step.step);
    } else {
      const existing = stepMap.get(step.step)!;
      if (step.timestamp > existing.timestamp) {
        stepMap.set(step.step, step);
      }
    }
  }

  const toolRunCount = workbench.filter(
    (e) => e.kind === "tool_call" || e.kind === "tool_result"
  ).length;
  const summaryParts: string[] = [];
  if (stepOrder.length) summaryParts.push(`${stepOrder.length} steps`);
  if (workbench.length) summaryParts.push(`${workbench.length} activity blocks`);
  if (toolRunCount) summaryParts.push(`${Math.ceil(toolRunCount / 2)} tool runs`);
  const summary = summaryParts.length ? summaryParts.join(" · ") : "Details";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3 ml-11">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-gray-200/80 bg-gray-50/90 px-3 py-2 text-left",
          "hover:bg-gray-100/90 transition-colors text-xs font-medium text-gray-700",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        )}
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            "h-4 w-4 text-gray-500 transition-transform shrink-0",
            open && "rotate-180"
          )}
        />
        <span className="flex-1 min-w-0">
          <span className="text-gray-800">Thinking &amp; backend activity</span>
          <span className="block text-[10px] font-normal text-gray-500 mt-0.5 truncate">
            {summary}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-3 overflow-hidden">
        {stepOrder.length > 0 && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Steps
            </div>
            {stepOrder.map((name) => (
              <StepRow key={name} step={stepMap.get(name)!} />
            ))}
          </div>
        )}
        {workbench.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              Workbench
            </div>
            <div className="space-y-2">
              {workbench.map((entry, idx) => (
                <WorkbenchBlock
                  key={entry.id}
                  entry={entry}
                  animate={
                    isStreaming && idx === workbench.length - 1
                  }
                />
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
