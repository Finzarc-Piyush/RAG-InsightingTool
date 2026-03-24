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
  codeKind,
}: {
  entry: AgentWorkbenchEntry;
  animate: boolean;
  codeKind: "sql" | "json" | "python";
}) {
  const revealed = useGradualReveal(entry.code, { active: animate });
  const [copied, setCopied] = useState(false);

  const codeKindLabel = codeKind === "sql" ? "SQL" : codeKind === "json" ? "JSON" : "Python";

  const copy = () => {
    void navigator.clipboard.writeText(entry.code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-zinc-950/75 to-zinc-950/95 overflow-hidden shadow-inner">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-gradient-to-r from-primary/10 via-transparent to-primary/5">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-zinc-200 truncate">
            {entry.title}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-zinc-200">
              {codeKindLabel}
            </span>
            <span className="text-[10px] text-zinc-500 font-mono truncate">{entry.kind}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex-shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 bg-white/0 hover:bg-white/5 transition-colors"
          aria-label="Copy to clipboard"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      {copied && (
        <div className="px-4 py-1 text-[10px] text-emerald-300 bg-zinc-900/80 border-b border-white/10">
          Copied
        </div>
      )}
      <pre
        className={cn(
          "text-[11px] leading-relaxed p-4 overflow-x-auto max-h-64 overflow-y-auto",
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

  const pillClass =
    step.status === "completed"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : step.status === "active"
        ? "border-primary/30 bg-primary/5"
        : step.status === "error"
          ? "border-red-500/30 bg-red-500/5"
          : "border-white/10 bg-white/5";

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
          <div className="text-xs text-muted-foreground mt-0.5">{step.details}</div>
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
    // Normalize to a primitive string to avoid duplicate React keys when
    // the runtime provides String objects (or values with identical stringification).
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

  type WorkbenchCodeKind = "sql" | "json" | "python";
  type VisibleWorkbenchEntry = { entry: AgentWorkbenchEntry; codeKind: WorkbenchCodeKind };

  const classifyWorkbenchCodeKind = (
    entry: AgentWorkbenchEntry
  ): WorkbenchCodeKind | null => {
    const code = (entry.code ?? "").trim();
    if (!code) return null;

    const lang = entry.language?.toLowerCase().trim();
    if (lang) {
      if (lang.includes("sql")) return "sql";
      if (lang.includes("json")) return "json";
      if (lang.includes("python") || lang.includes("py")) return "python";
    }

    const lower = code.toLowerCase();
    // JSON: parseable object/array payloads.
    const looksLikeJson =
      (code.startsWith("{") && code.endsWith("}")) ||
      (code.startsWith("[") && code.endsWith("]"));
    if (looksLikeJson) {
      try {
        JSON.parse(code);
        return "json";
      } catch {
        // fall through
      }
    }

    // SQL: common DML/DDL/DQL tokens.
    const sqlToken =
      /\b(select|with|insert|update|delete|create|alter|drop|union|join)\b/i.test(lower);
    if (sqlToken) return "sql";

    // Python: common defs/imports/control tokens.
    const pythonToken =
      /\b(def|class|import|from|print|range|len|for|while|try|except|elif|else)\b/.test(lower);
    if (pythonToken) return "python";

    return null;
  };

  const visibleWorkbench: VisibleWorkbenchEntry[] = [];
  for (const entry of workbench) {
    const codeKind = classifyWorkbenchCodeKind(entry);
    if (codeKind) visibleWorkbench.push({ entry, codeKind });
  }

  const summaryParts: string[] = [];
  if (stepOrder.length) summaryParts.push(`${stepOrder.length} steps`);
  if (visibleWorkbench.length) summaryParts.push(`${visibleWorkbench.length} code blocks`);
  // Keep the summary aligned with what we actually render.
  const visibleToolRunsCount = visibleWorkbench.filter(
    (e) => e.entry.kind === "tool_call" || e.entry.kind === "tool_result"
  ).length;
  if (visibleToolRunsCount) summaryParts.push(`${Math.ceil(visibleToolRunsCount / 2)} tool runs`);
  const summary = summaryParts.length ? summaryParts.join(" · ") : "Details";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-3 ml-11">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-2xl border px-4 py-2.5 text-left",
          "border-white/10 bg-gradient-to-r from-primary/10 via-background to-primary/5",
          "backdrop-blur supports-[backdrop-filter]:bg-background/60",
          "hover:border-primary/20 transition-all text-xs font-semibold text-foreground/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 shadow-sm hover:shadow-md"
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
          <span className="text-foreground">Thinking & backend activity</span>
          <span className="block text-[10px] font-normal text-muted-foreground mt-0.5 truncate">
            {summary}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-4 overflow-hidden">
        {stepOrder.length > 0 && (
          <div className="space-y-1.5 pl-0.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Steps
            </div>
            {stepOrder.map((name) => (
              <StepRow key={name} step={stepMap.get(name)!} />
            ))}
          </div>
        )}
        {visibleWorkbench.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Workbench (SQL / JSON / Python)
            </div>
            <div className="space-y-2">
              {visibleWorkbench.map(({ entry, codeKind }, idx) => (
                <WorkbenchBlock
                  key={entry.id}
                  entry={entry}
                  codeKind={codeKind}
                  animate={
                    isStreaming && idx === visibleWorkbench.length - 1
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
