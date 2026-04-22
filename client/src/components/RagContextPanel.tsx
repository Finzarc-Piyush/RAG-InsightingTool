import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Brain, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { sessionsApi } from "@/lib/api";
import type { SessionAnalysisContext } from "@shared/schema";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
  sidebarOpen: boolean;
}

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-emerald-500",
  medium: "text-amber-500",
  low: "text-muted-foreground",
};

export function RagContextPanel({ sessionId, sidebarOpen }: Props) {
  const [open, setOpen] = useState(false);

  const { data, isFetching, dataUpdatedAt } = useQuery<{
    sessionAnalysisContext: SessionAnalysisContext | null;
    enrichmentStatus: string | null;
    lastUpdatedAt: number;
  }>({
    queryKey: ["session-context", sessionId],
    queryFn: () => sessionsApi.getSessionAnalysisContext(sessionId),
    enabled: !!sessionId && sidebarOpen,
    staleTime: Infinity,
  });

  const ctx = data?.sessionAnalysisContext;
  if (!ctx) return null;

  const updatedAt = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 w-full justify-start gap-2 rounded-xl px-3 py-2.5 text-sidebar-foreground hover:bg-sidebar-accent/80"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
          )}
          <Brain className="h-5 w-5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-start font-medium leading-none">
            RAG Context
          </span>
          {isFetching && (
            <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mx-2 mb-2 mt-0.5 rounded-lg border border-border bg-card p-3 text-xs space-y-3">
          {/* Description */}
          {ctx.dataset.shortDescription && (
            <p className="text-muted-foreground leading-relaxed">
              {ctx.dataset.shortDescription}
            </p>
          )}

          {ctx.dataset.grainGuess && (
            <div>
              <span className="font-semibold text-foreground">Row grain: </span>
              <span className="text-muted-foreground">{ctx.dataset.grainGuess}</span>
            </div>
          )}

          {/* Column roles */}
          {ctx.dataset.columnRoles.length > 0 && (
            <Section title="Column roles">
              {ctx.dataset.columnRoles.map((c) => (
                <div key={c.name} className="flex gap-1.5">
                  <span className="font-medium text-foreground shrink-0">{c.name}</span>
                  <span className="text-muted-foreground">· {c.role}</span>
                  {c.notes && <span className="text-muted-foreground/70">— {c.notes}</span>}
                </div>
              ))}
            </Section>
          )}

          {/* Caveats */}
          {ctx.dataset.caveats.length > 0 && (
            <Section title="Caveats">
              {ctx.dataset.caveats.map((c, i) => (
                <div key={i} className="text-muted-foreground">• {c}</div>
              ))}
            </Section>
          )}

          {/* User intent constraints */}
          {ctx.userIntent.interpretedConstraints.length > 0 && (
            <Section title="User intent">
              {ctx.userIntent.interpretedConstraints.map((c, i) => (
                <div key={i} className="text-muted-foreground">• {c}</div>
              ))}
            </Section>
          )}

          {/* Facts learned */}
          {ctx.sessionKnowledge.facts.length > 0 && (
            <Section title="Facts learned">
              {ctx.sessionKnowledge.facts.map((f, i) => (
                <div key={i} className="flex gap-1.5">
                  <span className={cn("shrink-0 font-medium", CONFIDENCE_COLOR[f.confidence])}>
                    [{f.confidence[0].toUpperCase()}]
                  </span>
                  <span className="text-muted-foreground">{f.statement}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Analyses done */}
          {ctx.sessionKnowledge.analysesDone.length > 0 && (
            <Section title="Analyses done">
              {ctx.sessionKnowledge.analysesDone.map((a, i) => (
                <div key={i} className="text-muted-foreground">• {a}</div>
              ))}
            </Section>
          )}

          {/* Suggested follow-ups */}
          {ctx.suggestedFollowUps.length > 0 && (
            <Section title="Suggested questions">
              {ctx.suggestedFollowUps.map((q, i) => (
                <div key={i} className="text-muted-foreground">• {q}</div>
              ))}
            </Section>
          )}

          {/* Footer */}
          {updatedAt && (
            <p className="text-muted-foreground/50 pt-1 border-t border-border">
              Updated at {updatedAt} · reason: {ctx.lastUpdated.reason}
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-semibold text-foreground uppercase tracking-wide text-[10px]">{title}</p>
      {children}
    </div>
  );
}
