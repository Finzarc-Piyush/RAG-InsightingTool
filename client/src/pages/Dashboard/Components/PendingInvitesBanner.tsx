import { useState } from "react";
import { Mail, CheckCircle2, X as XIcon, Loader2, Edit, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSharedDashboards } from "@/hooks/useSharedDashboards";
import type {
  SharedDashboardInvite,
  Dashboard as ServerDashboard,
} from "@/shared/schema";

/**
 * Wave DR16 · pending-invites banner.
 *
 * Replaces the dedicated `SharedDashboardsPanel` left-column on the
 * dashboard list page. Accepted dashboards are already surfaced in the
 * main grid and filterable via the All / Owned / Shared toggle (DR7b),
 * so the only piece of UX still owed by the panel was the
 * accept/decline action on incoming invites — that's what this banner
 * is for.
 *
 * Behaviour:
 *   • Renders nothing when `pending.length === 0` (the common case).
 *     The dashboard list is full-bleed; no permanent visual cost.
 *   • When invites are present: a single-row banner above the list with
 *     the count + a "Review invitations" button.
 *   • Clicking opens a modal listing each pending invite with the
 *     existing Accept / Decline actions.
 *   • Accept invokes `onAccepted` so the parent can navigate straight
 *     to the freshly-accepted dashboard.
 */

interface PendingInvitesBannerProps {
  onAccepted?: (data: { invite: SharedDashboardInvite; dashboard: ServerDashboard }) => void;
}

const formatTimestamp = (value?: number) => {
  if (!value) return "—";
  const date = new Date(value);
  return `${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

export function PendingInvitesBanner({ onAccepted }: PendingInvitesBannerProps) {
  const { pending, acceptInvite, declineInvite, isMutating, refresh } =
    useSharedDashboards();
  const [open, setOpen] = useState(false);

  if (pending.length === 0) return null;

  return (
    <>
      <div
        role="region"
        aria-label="Pending dashboard invitations"
        className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
        data-testid="pending-invites-banner"
      >
        <Mail className="h-4 w-4 text-primary flex-shrink-0" aria-hidden="true" />
        <span className="text-sm text-foreground">
          You have{" "}
          <strong>
            {pending.length} pending invitation{pending.length === 1 ? "" : "s"}
          </strong>{" "}
          to review.
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          className="ml-auto"
        >
          Review invitations
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[560px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-primary" />
              Pending dashboard invitations
            </DialogTitle>
            <DialogDescription>
              Accepting an invitation adds the dashboard to your list and opens
              it. Declining removes the invitation.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-3 mt-2">
            {pending.map((invite) => (
              <li
                key={invite.id}
                className="rounded-md border border-border bg-card p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-foreground truncate">
                      {invite.preview?.name ?? "Shared dashboard"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      from {invite.ownerEmail}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      sent {formatTimestamp(invite.createdAt)}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      invite.permission === "edit"
                        ? "border-primary/40 text-primary"
                        : "border-border text-muted-foreground"
                    }
                  >
                    {invite.permission === "edit" ? (
                      <>
                        <Edit className="h-3 w-3 mr-1" />
                        Edit
                      </>
                    ) : (
                      <>
                        <Eye className="h-3 w-3 mr-1" />
                        View
                      </>
                    )}
                  </Badge>
                </div>
                {invite.note ? (
                  <p className="text-xs italic text-muted-foreground border-l-2 border-primary/40 pl-2">
                    "{invite.note}"
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={isMutating}
                    className="flex-1"
                    onClick={async () => {
                      const result = await acceptInvite(invite.id);
                      if (result && onAccepted) {
                        onAccepted(result);
                      }
                      // Close the modal once the queue clears.
                      if (pending.length <= 1) setOpen(false);
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                    Accept & open
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isMutating}
                    onClick={() => {
                      void declineInvite(invite.id);
                      if (pending.length <= 1) setOpen(false);
                    }}
                  >
                    <XIcon className="h-3.5 w-3.5 mr-1.5" />
                    Decline
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={isMutating}
            >
              {isMutating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Refreshing…
                </>
              ) : (
                "Refresh"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
