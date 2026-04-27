/**
 * W11 · StepByStepInsightsPanel
 *
 * Renders a collapsible "Step-by-step interpretation" card after the auto-
 * pivot table and above the markdown answer block. Each row corresponds to
 * a meaningful `AgentWorkbenchEntry` and surfaces its W10 `insight` line so
 * the user can see, in plain language, what each phase of the investigation
 * actually contributed — not just raw JSON.
 *
 * Filters out no-op `flow_decision` entries (default → default routing) so
 * the panel stays signal-dense. Hidden entirely when no entries carry a
 * non-empty insight.
 *
 * Styling uses semantic tokens only (per client/THEMING.md): bg-card,
 * bg-muted/30, text-foreground, text-muted-foreground, text-primary,
 * border-border. No raw hex / Tailwind palette literals.
 */
import { useState } from "react";
import type { AgentWorkbenchEntry } from "@/shared/schema";
import {
  ChevronDown,
  ChevronRight,
  ListOrdered,
  PlayCircle,
  Wrench,
  CheckCircle2,
  XCircle,
  GitBranch,
  ShieldCheck,
  ArrowRightLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface StepByStepInsightsPanelProps {
  workbench: AgentWorkbenchEntry[] | undefined;
  /** Default open state. Defaults to false (the panel is opt-in detail). */
  defaultOpen?: boolean;
}

function iconFor(entry: AgentWorkbenchEntry) {
  switch (entry.kind) {
    case "plan":
      return <ListOrdered className="h-3.5 w-3.5 text-primary" aria-hidden />;
    case "tool_call":
      return <Wrench className="h-3.5 w-3.5 text-primary" aria-hidden />;
    case "tool_result":
      // No reliable ok/failed flag on the persisted entry — treat all as success
      // visually. Failure cases surface in the insight text via "Tool failed:".
      return entry.insight?.startsWith("Tool failed") ? (
        <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-primary" aria-hidden />
      );
    case "flow_decision":
      return <GitBranch className="h-3.5 w-3.5 text-primary" aria-hidden />;
    case "critic":
      return <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />;
    case "handoff":
      return <ArrowRightLeft className="h-3.5 w-3.5 text-primary" aria-hidden />;
    default:
      return <PlayCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />;
  }
}

function isMeaningful(entry: AgentWorkbenchEntry): boolean {
  // Drop no-op routing rows (e.g. layer "default" → chosen "default") that
  // carry no insight or override. They add noise without explaining anything.
  if (entry.kind === "flow_decision") {
    const flow = entry.flowDecision;
    if (!entry.insight && !flow?.overriddenBy && !flow?.reason) return false;
  }
  return Boolean(entry.insight?.trim());
}

export function StepByStepInsightsPanel({
  workbench,
  defaultOpen = false,
}: StepByStepInsightsPanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const meaningful = (workbench ?? []).filter(isMeaningful);
  if (meaningful.length === 0) return null;

  return (
    <section
      className="mb-3 rounded-brand-md border border-border/60 bg-card"
      aria-label="Step-by-step interpretation"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-muted/30 transition-colors rounded-brand-md"
        aria-expanded={open}
        aria-controls="step-by-step-panel-body"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          )}
          Step-by-step interpretation
          <span className="rounded-full bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {meaningful.length} step{meaningful.length === 1 ? "" : "s"}
          </span>
        </span>
        <span className="text-[11px] text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <ol
          id="step-by-step-panel-body"
          className="space-y-2 px-4 pb-3"
        >
          {meaningful.map((entry, i) => (
            <li
              key={entry.id ?? i}
              className={cn(
                "rounded-md border border-border/40 bg-muted/20 px-3 py-2",
                "flex items-start gap-2.5"
              )}
            >
              <span
                className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary"
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {iconFor(entry)}
                  <p className="text-[12px] font-medium text-foreground/90">
                    {entry.title}
                  </p>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                  {entry.insight}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
