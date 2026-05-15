import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BarChart3, Calendar, Trash2, Eye, Share2, Users, Edit, EyeOff, Lightbulb, Plus, Search } from 'lucide-react';
import { DashboardData } from '../modules/useDashboardState';
import { Skeleton } from '@/components/ui/skeleton';
import { ShareDashboardDialog } from './ShareDashboardDialog';
import { DashboardCardThumbnails } from './DashboardCardThumbnails';
import { OpenChatButton } from './OpenChatButton';
import { getUserEmail } from '@/utils/userStorage';
import {
  filterAndSortDashboards,
  type DashboardScope,
  type DashboardSort,
} from '../dashboardListFilters';
import { cn } from '@/lib/utils';

interface DashboardListProps {
  dashboards: DashboardData[];
  isLoading?: boolean;
  isRefreshing?: boolean;
  onViewDashboard: (dashboard: DashboardData) => void;
  onDeleteDashboard: (dashboardId: string) => void;
  /** Wave DR7a · optional create-from-list affordance. */
  onCreateDashboard?: () => void;
}

const SkeletonCard = () => (
  <Card className="border-0">
    <CardHeader className="pb-3">
      <div className="flex items-start justify-between">
        <div className="flex-1 space-y-3">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-6 w-16 rounded-full" />
      </div>
    </CardHeader>
    <CardContent className="space-y-4 pt-0">
      <Skeleton className="h-4 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-10 rounded-md" />
      </div>
    </CardContent>
  </Card>
);

export function DashboardList({
  dashboards,
  isLoading = false,
  isRefreshing = false,
  onViewDashboard,
  onDeleteDashboard,
  onCreateDashboard,
}: DashboardListProps) {
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [selectedDashboard, setSelectedDashboard] = useState<DashboardData | null>(null);
  // Wave DR7b · client-side search / scope / sort. State is per-render
  // (not URL-synced); the cost of a refresh resetting filters is small
  // and avoids a wouter integration here.
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<DashboardScope>("all");
  const [sort, setSort] = useState<DashboardSort>("updated");

  const visibleDashboards = useMemo(
    () => filterAndSortDashboards(dashboards, { query, scope, sort }),
    [dashboards, query, scope, sort],
  );

  const handleShareClick = (dashboard: DashboardData) => {
    setSelectedDashboard(dashboard);
    setShareDialogOpen(true);
  };

  // Helper function to check if user can edit a dashboard
  const canEditDashboard = useMemo(() => {
    const userEmail = getUserEmail()?.toLowerCase();
    return (dashboard: DashboardData): boolean => {
      // If it's a shared dashboard, check the permission
      if (dashboard.isShared && dashboard.sharedPermission) {
        return dashboard.sharedPermission === "edit";
      }
      // Check if user is a collaborator with edit permission
      if (dashboard.collaborators && userEmail) {
        const collaborator = dashboard.collaborators.find(
          (c) => c.userId.toLowerCase() === userEmail
        );
        if (collaborator && collaborator.permission === "edit") {
          return true;
        }
      }
      // Check ownership
      const dashboardUsername = dashboard.username?.toLowerCase();
      return userEmail === dashboardUsername;
    };
  }, []);
  if (!isLoading && dashboards.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center py-12">
        <div className="rounded-full bg-muted p-6 mb-4">
          <BarChart3 className="h-12 w-12 text-muted-foreground" />
        </div>
        <h3 className="text-xl font-semibold text-foreground mb-2">No Dashboards Yet</h3>
        <p className="text-muted-foreground mb-6 max-w-md">
          Create your first dashboard by adding charts from your data analysis. 
          Click the plus button on any chart to get started.
        </p>
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Lightbulb className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>Upload and analyze data first, then add charts to a dashboard from the chat.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 pb-4">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground mb-2">Your Dashboards</h1>
            <p className="text-muted-foreground flex items-center gap-2">
              Manage and view your saved dashboards
              {isRefreshing && (
                <Badge variant="outline" className="text-xs font-medium uppercase tracking-wide">
                  Updating…
                </Badge>
              )}
            </p>
          </div>
          {onCreateDashboard ? (
            <Button onClick={onCreateDashboard} className="flex-shrink-0">
              <Plus className="h-4 w-4 mr-2" />
              New dashboard
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex-shrink-0 mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search dashboards..."
            className="pl-8"
            aria-label="Search dashboards"
          />
        </div>
        <div
          role="group"
          aria-label="Filter by scope"
          className="inline-flex rounded-md border border-border overflow-hidden"
        >
          {(["all", "owned", "shared"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                scope === s
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/40",
              )}
              aria-pressed={scope === s}
            >
              {s === "all" ? "All" : s === "owned" ? "Owned" : "Shared with me"}
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as DashboardSort)}>
          <SelectTrigger className="w-[160px]" aria-label="Sort dashboards">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">Recently updated</SelectItem>
            <SelectItem value="created">Recently created</SelectItem>
            <SelectItem value="name">Name (A → Z)</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {visibleDashboards.length} of {dashboards.length}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pb-6 max-h-full">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading
          ? Array.from({ length: 3 }).map((_, index) => <SkeletonCard key={`skeleton-${index}`} />)
          : visibleDashboards.map((dashboard) => (
          <Card key={dashboard.id} className="hover:shadow-none transition-shadow border-0">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <CardTitle className="text-lg font-semibold text-foreground">
                      {dashboard.name}
                    </CardTitle>
                    {/* Show "Shared" badge if dashboard is shared WITH the user OR if it has collaborators (shared BY the user) */}
                    {(dashboard.isShared || dashboard.hasCollaborators) && (
                      <Badge variant="secondary" className="text-xs px-2 py-0.5">
                        <Users className="h-3 w-3 mr-1" />
                        Shared
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    <span>Updated {dashboard.updatedAt.toLocaleDateString()}</span>
                    {/* Show "by [email]" only if shared WITH the user (not if shared BY the user) */}
                    {dashboard.isShared && dashboard.sharedBy && (
                      <>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-xs">by {dashboard.sharedBy}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-1 items-end">
                  <Badge variant="secondary" className="ml-2">
                    {dashboard.sheets?.length || 1} sheet{(dashboard.sheets?.length || 1) === 1 ? '' : 's'}
                  </Badge>
                  {dashboard.isShared && dashboard.sharedPermission && (
                    <Badge
                      variant="outline"
                      className={`text-xs px-2 py-0.5 ${
                        dashboard.sharedPermission === "edit"
                          ? "border-primary/40 text-primary"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      {dashboard.sharedPermission === "edit" ? (
                        <>
                          <Edit className="h-3 w-3 mr-1" />
                          Edit
                        </>
                      ) : (
                        <>
                          <EyeOff className="h-3 w-3 mr-1" />
                          View
                        </>
                      )}
                    </Badge>
                  )}
                </div>
              </div>
            </CardHeader>
            
            <CardContent className="pt-0">
              <div className="space-y-3">
                <DashboardCardThumbnails sheets={dashboard.sheets} />

                <div className="flex gap-2">
                  <Button
                    onClick={() => onViewDashboard(dashboard)}
                    className="flex-1"
                    disabled={false}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    View Dashboard
                  </Button>

                  {/* DR15 · open the source chat. Hidden when the
                      dashboard has no source linkage or is shared with
                      the current user (the source session is the
                      owner's, not the viewer's). */}
                  <OpenChatButton dashboard={dashboard} variant="compact" />

                  {canEditDashboard(dashboard) && (
                    <>
                      {/* Only show share button for owned dashboards (not shared with user) */}
                      {!dashboard.isShared && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => handleShareClick(dashboard)}
                          className="text-primary hover:bg-primary/10"
                          title="Share dashboard"
                        >
                          <Share2 className="h-4 w-4" />
                        </Button>
                      )}
                      
                      {/* Show delete button for users with edit permission */}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => onDeleteDashboard(dashboard.id)}
                        className="text-destructive hover:text-destructive"
                        title="Delete dashboard"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        </div>
      </div>
      <ShareDashboardDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        dashboardId={selectedDashboard?.id}
        dashboardName={selectedDashboard?.name}
      />
    </div>
  );
}
