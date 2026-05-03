/**
 * BuildDashboardCallout — Phase-2 "offer" surface.
 *
 * Renders a wide, premium-styled "Build Dashboard" button when the agent
 * emitted a `dashboardDraft` but did NOT auto-persist it (multi-chart turn
 * without an explicit ask). Clicking persists the spec via
 * `/api/dashboards/from-spec` and navigates to `/dashboard?open=<id>`.
 *
 * Two slots inside MessageBubble use this:
 *   - "above-answer": rendered below the ThinkingPanel
 *   - "below-answer": rendered at the bottom of the answer card / key insights
 *
 * The post-create / explicit-ask path continues to use DashboardDraftCard
 * (which renders Open + Share once `createdDashboardId` is set).
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { dashboardsApi } from "@/lib/api/dashboards";
import { dashboardSpecSchema, type DashboardSpec } from "@/shared/schema";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { Loader2, LayoutDashboard, ArrowUpRight, Sparkles } from "lucide-react";

interface BuildDashboardCalloutProps {
  /** Raw draft from `message.dashboardDraft` — record<unknown> on the wire. */
  draft: unknown;
  sessionId?: string;
  /**
   * Spacing variant. `above-answer` sits below the ThinkingPanel and gets a
   * bit more top margin; `below-answer` sits at the tail of the answer card.
   */
  variant: "above-answer" | "below-answer";
}

function parseDraft(raw: unknown): DashboardSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const out = dashboardSpecSchema.safeParse(raw);
  return out.success ? out.data : null;
}

export function BuildDashboardCallout({
  draft,
  sessionId,
  variant,
}: BuildDashboardCalloutProps) {
  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "creating" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  if (!parsed) return null;

  const totalCharts = parsed.sheets.reduce(
    (n, s) => n + (Array.isArray(s.charts) ? s.charts.length : 0),
    0
  );

  const handleClick = async () => {
    if (status.kind === "creating") return;
    setStatus({ kind: "creating" });
    try {
      const dashboard = await dashboardsApi.createFromSpec(parsed, sessionId);
      toast({
        title: "Dashboard created",
        description: `Opening "${dashboard.name}"…`,
      });
      setLocation(`/dashboard?open=${encodeURIComponent(dashboard.id)}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not create dashboard";
      logger.error("BuildDashboardCallout createFromSpec failed", err);
      setStatus({ kind: "error", message });
    }
  };

  const isCreating = status.kind === "creating";
  const wrapperSpacing =
    variant === "above-answer" ? "mt-3 mb-2" : "mt-4";

  return (
    <div className={wrapperSpacing}>
      <button
        type="button"
        onClick={handleClick}
        disabled={isCreating}
        aria-label={`Build the "${parsed.name}" dashboard from this analysis`}
        data-testid="build-dashboard-callout"
        className={[
          // Full-width, message-bubble-wide.
          "group relative w-full",
          // Premium gradient border via padding + nested layer.
          "rounded-brand-lg p-[1px]",
          "bg-gradient-to-r from-primary/40 via-primary/20 to-primary/5",
          // Subtle glow on hover. Token-only colors per THEMING.md.
          "transition-shadow duration-200",
          "hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.4),0_8px_24px_-12px_hsl(var(--primary)/0.5)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          "disabled:opacity-60 disabled:cursor-not-allowed",
        ].join(" ")}
      >
        <div
          className={[
            "flex items-center gap-3 rounded-[calc(var(--radius)-1px)]",
            "bg-card px-4 py-3 text-left",
          ].join(" ")}
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <LayoutDashboard className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground">
                Build Dashboard
              </span>
              <Sparkles
                className="h-3.5 w-3.5 text-primary/80"
                aria-hidden="true"
              />
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {parsed.name}
              {" · "}
              {parsed.sheets.length} sheet
              {parsed.sheets.length === 1 ? "" : "s"}
              {totalCharts
                ? ` · ${totalCharts} chart${totalCharts === 1 ? "" : "s"}`
                : ""}
            </div>
            {status.kind === "error" ? (
              <div className="mt-1 text-xs text-destructive">
                {status.message}
              </div>
            ) : null}
          </div>
          <div className="shrink-0">
            {isCreating ? (
              <Loader2
                className="h-4 w-4 animate-spin text-primary"
                aria-hidden="true"
              />
            ) : (
              <ArrowUpRight
                className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </button>
    </div>
  );
}
