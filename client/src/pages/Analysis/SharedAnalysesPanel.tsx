import { useMemo } from "react";
import { AnalysisSessionSummary, SharedAnalysisInvite } from "@/shared/schema";
import { useSharedAnalyses } from "@/hooks/useSharedAnalyses";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Mail, RefreshCcw, Share2, Users, Clock, CheckCircle2, BarChart3, Lightbulb, MessageSquare, User } from "lucide-react";

interface SharedAnalysesPanelProps {
  onAccepted?: (summary: AnalysisSessionSummary) => void;
}

const formatTimestamp = (value?: number) => {
  if (!value) return "—";
  const date = new Date(value);
  return `${date.toLocaleDateString()} · ${date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};

const PreviewStats = ({ invite }: { invite: SharedAnalysisInvite }) => {
  if (!invite.preview) return null;
  const { preview } = invite;
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <BarChart3 className="h-3.5 w-3.5 text-blue-500" />
        <span className="font-medium">{preview.chartsCount}</span>
        <span className="text-muted-foreground">charts</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Lightbulb className="h-3.5 w-3.5 text-amber-500" />
        <span className="font-medium">{preview.insightsCount}</span>
        <span className="text-muted-foreground">insights</span>
      </div>
      <div className="flex items-center gap-1.5">
        <MessageSquare className="h-3.5 w-3.5 text-green-500" />
        <span className="font-medium">{preview.messagesCount}</span>
        <span className="text-muted-foreground">messages</span>
      </div>
    </div>
  );
};

export const SharedAnalysesPanel = ({ onAccepted }: SharedAnalysesPanelProps) => {
  const {
    pending,
    accepted,
    loading,
    error,
    refresh,
    acceptInvite,
    declineInvite,
    isMutating,
    hasSharedItems,
  } = useSharedAnalyses();

  const pendingInvites = useMemo(() => pending.slice(0, 5), [pending]);
  const acceptedInvites = useMemo(() => accepted.slice(0, 5), [accepted]);

  const renderInviteCard = (invite: SharedAnalysisInvite) => (
    <div
      key={invite.id}
      className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4 shadow-sm hover:shadow-md transition-all duration-200"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse"></div>
            <p className="text-base font-semibold text-foreground truncate">
              {invite.preview?.fileName ?? "Shared analysis"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{invite.ownerEmail}</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{formatTimestamp(invite.createdAt)}</span>
          </div>
        </div>
        <Badge variant="secondary" className="gap-1.5 text-xs px-2.5 py-1 flex-shrink-0">
          <Mail className="h-3 w-3" />
          <span className="hidden sm:inline">{invite.targetEmail}</span>
        </Badge>
      </div>
      
      {invite.note && (
        <div className="bg-primary/10 border-l-4 border-primary/50 rounded-r-md p-3">
          <p className="text-sm text-foreground italic leading-relaxed">
            "{invite.note}"
          </p>
        </div>
      )}
      
      <div className="pt-2 border-t border-border">
        <PreviewStats invite={invite} />
      </div>
      
      <div className="flex gap-2.5 pt-1">
        <Button
          size="sm"
          className="flex-1 font-medium shadow-sm"
          disabled={isMutating}
          onClick={async () => {
            const summary = await acceptInvite(invite.id);
            if (summary && onAccepted) {
              onAccepted(summary);
            }
          }}
        >
          Join workspace
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-border text-foreground hover:bg-muted/50 font-medium"
          disabled={isMutating}
          onClick={() => declineInvite(invite.id)}
        >
          Decline
        </Button>
      </div>
    </div>
  );

  const renderAcceptedCard = (invite: SharedAnalysisInvite) => (
    <div
      key={`accepted-${invite.id}`}
      className="rounded-lg border border-border bg-card p-4 hover:shadow-sm transition-shadow duration-200"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
            <p className="font-semibold text-foreground text-sm truncate">
              {invite.preview?.fileName ?? "Shared analysis"}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground ml-6">
            <span>Accepted {formatTimestamp(invite.acceptedAt)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="truncate">from {invite.ownerEmail}</span>
          </div>
        </div>
        <Badge variant="outline" className="text-xs px-2.5 py-1 bg-primary/10 text-primary border-primary/25 flex-shrink-0">
          <Users className="h-3 w-3 mr-1" />
          Active
        </Badge>
      </div>
    </div>
  );

  return (
    <Card className="h-full flex flex-col border-border shadow-sm">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 flex-shrink-0 pb-4 border-b border-border">
        <div className="flex-1">
          <CardTitle className="flex items-center gap-2.5 text-xl font-bold text-foreground mb-1.5">
            <div className="p-1.5 rounded-lg bg-blue-100">
              <Share2 className="h-4 w-4 text-blue-600" />
            </div>
            Shared with you
          </CardTitle>
          <CardDescription className="text-sm text-muted-foreground ml-9">
            Join live collaborative analyses that teammates shared with you.
          </CardDescription>
        </div>
        <Button 
          variant="ghost" 
          size="sm" 
          onClick={refresh} 
          disabled={loading}
          className="hover:bg-muted text-foreground"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <RefreshCcw className="h-4 w-4 mr-1.5" />
              Refresh
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6 flex-1 overflow-y-auto pt-6">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center justify-between">
            <span>{error}</span>
            <Button variant="destructive" size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        )}

        {loading && (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {!loading && pendingInvites.length === 0 && !error && (
          <div className="rounded-xl border-2 border-dashed border-border bg-muted/30 p-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-3">
              <Users className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">
              {hasSharedItems
                ? "You're all caught up!"
                : "No shared analyses yet"}
            </p>
            <p className="text-xs text-muted-foreground">
              {hasSharedItems
                ? "Invite cards will show here when teammates share analyses."
                : "Ask a teammate to share an analysis with you."}
            </p>
          </div>
        )}

        {pendingInvites.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-2">
              <Clock className="h-4 w-4 text-amber-600" />
              <p className="text-xs font-bold text-foreground uppercase tracking-wider">
                Pending Invites
              </p>
              <Badge variant="secondary" className="ml-auto text-xs px-2 py-0.5 bg-amber-100 text-amber-700 border-amber-200">
                {pendingInvites.length}
              </Badge>
            </div>
            <div className="space-y-3">
              {pendingInvites.map(renderInviteCard)}
            </div>
          </div>
        )}

        {acceptedInvites.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 pb-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <p className="text-xs font-bold text-foreground uppercase tracking-wider">
                Recently Joined Workspaces
              </p>
              <Badge variant="secondary" className="ml-auto text-xs px-2 py-0.5 bg-green-100 text-green-700 border-green-200">
                {acceptedInvites.length}
              </Badge>
            </div>
            <div className="space-y-2.5">
              {acceptedInvites.map(renderAcceptedCard)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

