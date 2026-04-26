/**
 * DashboardDraftCard — Phase 2 preview surface.
 *
 * Renders an agent-emitted DashboardSpec as a compact inline card inside
 * an assistant message bubble. User clicks "Create dashboard" → POSTs to
 * /api/dashboards/from-spec → navigates to /dashboard?open=<id>.
 *
 * Failure modes:
 *   - draft is missing / not parseable → renders nothing.
 *   - create call rejects → inline error banner inside the card.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { dashboardsApi } from "@/lib/api/dashboards";
import { dashboardSpecSchema, type DashboardSpec } from "@/shared/schema";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import { Loader2, LayoutDashboard, ArrowUpRight, Share2 } from "lucide-react";
// W7.7 · share the just-created dashboard via the existing analysis-share dialog.
import { ShareAnalysisDialog } from "@/pages/Analysis/ShareAnalysisDialog";

interface DashboardDraftCardProps {
  /** Raw draft from `message.dashboardDraft` — record<unknown> on the wire. */
  draft: unknown;
  /**
   * Session this draft was produced in. Forwarded to
   * `dashboardsApi.createFromSpec` so the server can stamp the chat
   * session's `lastCreatedDashboardId`; the `patch_dashboard` agent
   * tool uses that stamp to resolve "the dashboard we just built"
   * on follow-up turns.
   */
  sessionId?: string;
}

function parseDraft(raw: unknown): DashboardSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const out = dashboardSpecSchema.safeParse(raw);
  return out.success ? out.data : null;
}

export function DashboardDraftCard({ draft, sessionId }: DashboardDraftCardProps) {
  const parsed = useMemo(() => parseDraft(draft), [draft]);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "creating" }
    | { kind: "created"; dashboardId: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [shareOpen, setShareOpen] = useState(false);

  if (!parsed) return null;

  const totalCharts = parsed.sheets.reduce(
    (n, s) => n + (Array.isArray(s.charts) ? s.charts.length : 0),
    0
  );
  const sheetNames = parsed.sheets.map((s) => s.name).filter(Boolean);

  const handleCreate = async () => {
    setStatus({ kind: "creating" });
    try {
      const dashboard = await dashboardsApi.createFromSpec(parsed, sessionId);
      setStatus({ kind: "created", dashboardId: dashboard.id });
      toast({
        title: "Dashboard created",
        description: parsed.name,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not create dashboard";
      logger.error("createFromSpec failed", err);
      setStatus({ kind: "error", message });
    }
  };

  const goToDashboard = () => {
    if (status.kind !== "created") return;
    setLocation(`/dashboard?open=${status.dashboardId}`);
  };

  return (
    <Card className="mt-3 border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-4 w-4 text-primary" />
          <CardTitle className="text-sm">Dashboard preview</CardTitle>
        </div>
        <CardDescription className="text-xs text-muted-foreground">
          {parsed.name}
          {" · "}
          {parsed.template.replace("_", " ")} template
          {" · "}
          {parsed.sheets.length} sheet{parsed.sheets.length === 1 ? "" : "s"}
          {totalCharts ? ` · ${totalCharts} chart${totalCharts === 1 ? "" : "s"}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {sheetNames.length > 0 ? (
          <ul className="text-xs text-muted-foreground list-disc ml-5 space-y-0.5">
            {sheetNames.map((n, i) => (
              <li key={`${n}-${i}`}>{n}</li>
            ))}
          </ul>
        ) : null}

        {status.kind === "error" ? (
          <div className="text-xs text-destructive">{status.message}</div>
        ) : null}

        <div className="flex items-center gap-2">
          {status.kind === "created" ? (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={goToDashboard}
                aria-label="Open the newly created dashboard"
              >
                <ArrowUpRight className="h-4 w-4 mr-1" />
                Open dashboard
              </Button>
              {/* W7.7 · share the saved dashboard with teammates. The existing
                  ShareAnalysisDialog reads the user's dashboards by sessionId
                  so the just-created one is pre-listed for selection. */}
              {sessionId ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShareOpen(true)}
                  aria-label="Share this dashboard with teammates"
                >
                  <Share2 className="h-4 w-4 mr-1" />
                  Share
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              size="sm"
              variant="default"
              onClick={handleCreate}
              disabled={status.kind === "creating"}
              aria-label="Create this dashboard"
            >
              {status.kind === "creating" ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Creating…
                </>
              ) : (
                <>Create dashboard</>
              )}
            </Button>
          )}
        </div>
      </CardContent>
      {sessionId ? (
        <ShareAnalysisDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          sessionId={sessionId}
          fileName={parsed.name}
        />
      ) : null}
    </Card>
  );
}
