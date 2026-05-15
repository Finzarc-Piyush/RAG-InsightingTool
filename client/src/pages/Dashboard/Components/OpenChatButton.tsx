import { MessageSquare, ChevronDown } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { DashboardData } from "../modules/useDashboardState";
import { dashboardSourceSessions } from "../dashboardSourceSessions";

/**
 * Wave DR15 · "Open chat" back-link from a dashboard to the chat that
 * produced it.
 *
 * Three states, all driven by `dashboardSourceSessions(dashboard)`:
 *
 *   • zero sources       → renders nothing (blank dashboards, dashboards
 *                          predating DR15 server changes)
 *   • exactly one source → renders a single Button that navigates to
 *                          `/analysis/<sessionId>` (App.tsx already
 *                          rehydrates the session via its existing
 *                          `urlSessionId` watcher)
 *   • multiple sources   → renders a DropdownMenu listing each source;
 *                          primary first, others tagged "via tile"
 *
 * Gating: `dashboard.isShared === true` returns nothing. Shared
 * dashboards may carry a `sessionId` the viewer has no Azure AD access
 * to; rather than surface a link that 404s, we hide the button.
 *
 * Variant prop tunes density:
 *   • "header"   — full Button with label, mounted in DashboardHeader
 *   • "compact"  — icon-only Button, mounted on list cards
 */

interface OpenChatButtonProps {
  dashboard: Pick<
    DashboardData,
    "sessionId" | "sheets" | "isShared"
  >;
  variant?: "header" | "compact";
  /**
   * Optional lookup that maps a sessionId to a friendly label (file
   * name, etc.) for the multi-source dropdown. Omitted entries fall
   * back to a truncated session id.
   */
  labelForSession?: (sessionId: string) => string | undefined;
}

export function OpenChatButton({
  dashboard,
  variant = "header",
  labelForSession,
}: OpenChatButtonProps) {
  const [, setLocation] = useLocation();
  const sources = dashboardSourceSessions(dashboard);
  // Hide on shared dashboards — the viewer's auth context probably can't
  // load the owner's session, and a 404 redirect would be jarring.
  if (dashboard.isShared) return null;
  if (sources.length === 0) return null;

  const navigate = (sessionId: string) => {
    setLocation(`/analysis/${encodeURIComponent(sessionId)}`);
  };

  const truncate = (id: string) => {
    if (id.length <= 14) return id;
    return `${id.slice(0, 6)}…${id.slice(-4)}`;
  };

  if (sources.length === 1) {
    const onlySource = sources[0];
    const isCompact = variant === "compact";
    return (
      <Button
        variant="outline"
        size={isCompact ? "icon" : "sm"}
        onClick={() => navigate(onlySource.sessionId)}
        title="Open the chat that produced this dashboard"
        className={cn(isCompact ? "" : "gap-1.5")}
        aria-label="Open chat"
      >
        <MessageSquare className={cn(isCompact ? "h-4 w-4" : "h-3.5 w-3.5")} />
        {!isCompact ? "Open chat" : null}
      </Button>
    );
  }

  // Multi-source — dropdown
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={variant === "compact" ? "icon" : "sm"}
          aria-label="Open one of the source chats"
          className={variant === "compact" ? "" : "gap-1.5"}
        >
          <MessageSquare className={variant === "compact" ? "h-4 w-4" : "h-3.5 w-3.5"} />
          {variant === "compact" ? null : (
            <>
              Open chat
              <ChevronDown className="h-3 w-3 opacity-70" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Source sessions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sources.map((s) => {
          const friendly = labelForSession?.(s.sessionId);
          return (
            <DropdownMenuItem
              key={s.sessionId}
              onSelect={() => navigate(s.sessionId)}
            >
              <MessageSquare className="h-4 w-4 mr-2 text-primary" />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm">
                  {friendly ?? truncate(s.sessionId)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.isPrimary ? "Primary source" : "From a pivot tile"}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
