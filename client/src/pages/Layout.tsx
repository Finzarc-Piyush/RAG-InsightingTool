import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  MessageSquare,
  BarChart3,
  TrendingUp,
  Menu,
  X,
  Upload,
  User,
  Share2,
  ChevronDown,
  ChevronRight,
  Table2,
  Loader2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import LogoutButton from '@/components/LogoutButton';
import { ShareAnalysisDialog } from '@/pages/Analysis/ShareAnalysisDialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ThemeToggle } from '@/components/theme-toggle';
import { useChatSidebarNav } from '@/contexts/ChatSidebarNavContext';
import { sessionsApi } from '@/lib/api';
import { getUserEmail } from '@/utils/userStorage';
import { useToast } from '@/hooks/use-toast';
import type { Session, SessionsResponse } from '@/pages/Analysis/types';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RagContextPanel } from '@/components/RagContextPanel';

interface LayoutProps {
  children: React.ReactNode;
  currentPage: 'home' | 'dashboard' | 'analysis';
  onNavigate: (page: 'home' | 'dashboard' | 'analysis') => void;
  onNewChat: () => void;
  onUploadNew?: () => void;
  onLoadSession?: (sessionId: string, sessionData: unknown) => void;
  sessionId?: string;
  fileName?: string;
}

const PAGE_COPY: Record<
  LayoutProps['currentPage'],
  { title: string; subtitle: string }
> = {
  home: {
    title: 'Chat',
    subtitle: 'Ask questions and explore your data',
  },
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Saved charts and layouts',
  },
  analysis: {
    title: 'Analysis history',
    subtitle: 'Browse and reopen sessions',
  },
};

const RECENT_SESSIONS_LIMIT = 10;

export function Layout({
  children,
  currentPage,
  onNavigate,
  onNewChat: _onNewChat,
  onUploadNew,
  onLoadSession,
  sessionId,
  fileName,
}: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [analysisNavOpen, setAnalysisNavOpen] = useState(false);
  const [pivotsNavOpen, setPivotsNavOpen] = useState(false);
  const [loadingSidebarSessionId, setLoadingSidebarSessionId] = useState<
    string | null
  >(null);
  const { user } = useAuth();
  const { toast } = useToast();
  const userEmail = getUserEmail();
  const { pivotEntries, requestPivotScroll } = useChatSidebarNav();

  const { data: sessionsData, isPending: sessionsPending } =
    useQuery<SessionsResponse>({
      queryKey: ['sessions', userEmail],
      queryFn: () => sessionsApi.getAllSessions(),
      enabled: !!userEmail,
    });

  const recentSessions = useMemo(() => {
    const list = sessionsData?.sessions ?? [];
    return [...list]
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, RECENT_SESSIONS_LIMIT);
  }, [sessionsData]);

  const navigationItems = [
    {
      id: 'home' as const,
      label: 'Chat',
      icon: MessageSquare,
    },
    {
      id: 'dashboard' as const,
      label: 'Dashboard',
      icon: BarChart3,
    },
  ];

  const page = PAGE_COPY[currentPage];

  const handleRecentSessionClick = async (session: Session) => {
    if (!onLoadSession || loadingSidebarSessionId) return;
    setLoadingSidebarSessionId(session.sessionId);
    try {
      const details = await sessionsApi.getSessionDetails(session.sessionId);
      onLoadSession(session.sessionId, details);
    } catch {
      toast({
        title: 'Error loading session',
        description: 'Failed to load session details. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setLoadingSidebarSessionId(null);
    }
  };

  const NavButton = (props: {
    item: (typeof navigationItems)[0];
    isActive: boolean;
  }) => {
    const { item, isActive } = props;
    const Icon = item.icon;
    // UX-6 · Nav item treatment.
    // Active = bg-primary/10 + left-accent bar (2px pill) that glides in
    // via animate-brand-underline. No more full-fill on the entire row
    // (the sledgehammer effect); the active item reads as "you're here"
    // without drowning the sidebar in primary.
    const button = (
      <Button
        id={`nav-${item.id}`}
        onClick={() => onNavigate(item.id)}
        variant="ghost"
        aria-current={isActive ? 'page' : undefined}
        aria-label={!sidebarOpen ? item.label : undefined}
        className={cn(
          'relative min-h-11 w-full justify-start gap-3 rounded-brand-md px-3 py-2.5 transition-colors duration-quick ease-standard motion-reduce:transition-none',
          isActive
            ? 'bg-primary/10 text-foreground'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/80',
          !sidebarOpen && 'justify-center px-0'
        )}
      >
        {isActive ? (
          <span
            aria-hidden="true"
            className="absolute left-1 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary animate-brand-underline origin-top"
          />
        ) : null}
        <Icon
          className={cn(
            'h-5 w-5 shrink-0',
            isActive ? 'text-primary' : undefined
          )}
          aria-hidden
        />
        {sidebarOpen && (
          <span
            className={cn(
              'min-w-0 truncate text-start font-medium leading-none',
              isActive ? 'text-foreground' : undefined
            )}
          >
            {item.label}
          </span>
        )}
      </Button>
    );

    if (!sidebarOpen) {
      return (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-[14rem] font-normal">
            <p className="font-medium">{item.label}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    return button;
  };

  const analysisDisclosureActive = currentPage === 'analysis';

  const analysisCollapsedIconButton = (
    <Button
      type="button"
      variant={analysisDisclosureActive ? 'default' : 'ghost'}
      aria-label="Analysis"
      aria-current={analysisDisclosureActive ? 'page' : undefined}
      onClick={() => onNavigate('analysis')}
      className={cn(
        'min-h-11 w-full justify-center rounded-xl px-0 py-2.5 transition-colors duration-200 motion-reduce:transition-none',
        analysisDisclosureActive
          ? 'bg-primary text-primary-foreground shadow-sm'
          : 'text-sidebar-foreground hover:bg-sidebar-accent/80'
      )}
    >
      <TrendingUp className="h-5 w-5 shrink-0" aria-hidden />
    </Button>
  );

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background">
      <a
        href="#main-content"
        className={cn(
          'fixed left-4 top-4 z-[100] -translate-y-[120%] rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-md',
          'transition-transform focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        )}
      >
        Skip to main content
      </a>

      {/* Sidebar */}
      <aside
        id="app-sidebar"
        className={cn(
          'flex min-h-0 min-w-0 flex-shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-300 ease-out motion-reduce:transition-none',
          sidebarOpen ? 'w-64' : 'w-[4.25rem]'
        )}
        aria-label="Primary navigation"
      >
        <div className="flex items-center justify-between gap-2 border-b border-sidebar-border/80 p-4">
          {sidebarOpen && (
            <div className="min-w-0">
              {/* UX-6 · Wordmark aligned with docs/brand/brand-guidebook.md §1.
                  Eyebrow-style vendor label + display-serif product name,
                  with a 1px hair-divider for rhythm between them. */}
              <p className="truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                Marico
              </p>
              <h1 className="truncate font-display text-[22px] font-semibold leading-7 tracking-[-0.02em] text-foreground">
                RAGAlytics
              </h1>
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-expanded={sidebarOpen}
            aria-controls="app-sidebar"
            className="h-10 w-10 shrink-0 rounded-lg"
          >
            {sidebarOpen ? (
              <X className="h-4 w-4" aria-hidden />
            ) : (
              <Menu className="h-4 w-4" aria-hidden />
            )}
            <span className="sr-only">
              {sidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
            </span>
          </Button>
        </div>

        <nav
          className="flex flex-1 flex-col gap-1 overflow-y-auto p-3"
          aria-label="App sections"
        >
          <NavButton
            key="home"
            item={navigationItems[0]}
            isActive={currentPage === 'home'}
          />

          {sidebarOpen &&
            currentPage === 'home' &&
            pivotEntries.length > 0 && (
              <Collapsible open={pivotsNavOpen} onOpenChange={setPivotsNavOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 w-full justify-start gap-2 rounded-xl px-3 py-2.5 text-sidebar-foreground hover:bg-sidebar-accent/80"
                  >
                    {pivotsNavOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <Table2 className="h-5 w-5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-start font-medium leading-none">
                      Pivots
                    </span>
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-0.5 pl-2 pt-0.5">
                  {pivotEntries.map((entry) => (
                    <Button
                      key={entry.id}
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-auto min-h-9 w-full justify-start whitespace-normal rounded-lg px-3 py-1.5 text-left text-xs font-normal text-sidebar-foreground hover:bg-sidebar-accent/80"
                      onClick={() => requestPivotScroll(entry.id)}
                    >
                      <span className="line-clamp-2">{entry.label}</span>
                    </Button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}

          {sidebarOpen && sessionId && currentPage === 'home' && (
            <RagContextPanel sessionId={sessionId} sidebarOpen={sidebarOpen} />
          )}

          <NavButton
            key="dashboard"
            item={navigationItems[1]}
            isActive={currentPage === 'dashboard'}
          />

          {sidebarOpen ? (
            <Collapsible
              open={analysisNavOpen}
              onOpenChange={setAnalysisNavOpen}
            >
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant={analysisDisclosureActive ? 'default' : 'ghost'}
                  aria-expanded={analysisNavOpen}
                  aria-current={analysisDisclosureActive ? 'page' : undefined}
                  className={cn(
                    'min-h-11 w-full justify-start gap-2 rounded-xl px-3 py-2.5 transition-colors duration-200 motion-reduce:transition-none',
                    analysisDisclosureActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent/80'
                  )}
                >
                  {analysisNavOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                  )}
                  <TrendingUp className="h-5 w-5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-start font-medium leading-none">
                    Analysis
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent
                forceMount
                className="space-y-0.5 pl-2 pt-0.5 data-[state=closed]:hidden"
              >
                {sessionsPending && !sessionsData && (
                  <p className="px-3 py-1 text-xs text-muted-foreground">
                    Loading…
                  </p>
                )}
                {!(sessionsPending && !sessionsData) &&
                  recentSessions.map((session) => {
                    const busy =
                      loadingSidebarSessionId === session.sessionId;
                    return (
                      <Button
                        key={session.sessionId}
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        className="h-auto min-h-9 w-full justify-start gap-2 whitespace-normal rounded-lg px-3 py-1.5 text-left text-xs font-normal text-sidebar-foreground hover:bg-sidebar-accent/80"
                        onClick={() => handleRecentSessionClick(session)}
                      >
                        {busy ? (
                          <Loader2
                            className="h-3.5 w-3.5 shrink-0 animate-spin"
                            aria-hidden
                          />
                        ) : null}
                        <span className="line-clamp-2">{session.fileName}</span>
                      </Button>
                    );
                  })}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-8 w-full justify-start px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => onNavigate('analysis')}
                >
                  Browse all
                </Button>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>{analysisCollapsedIconButton}</TooltipTrigger>
              <TooltipContent side="right" className="max-w-[14rem] font-normal">
                <p className="font-medium">Analysis</p>
                <p className="text-xs text-muted-foreground">
                  Expand sidebar for recent sessions
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </nav>

        <div
          className={cn(
            'border-t border-sidebar-border p-3',
            sidebarOpen ? 'bg-sidebar/80' : 'flex flex-col items-center bg-sidebar/80'
          )}
        >
          {sidebarOpen ? (
            <>
              <div className="mb-3 flex items-center gap-3">
                <Avatar className="h-10 w-10 border border-border/60">
                  <AvatarImage
                    src={user?.idTokenClaims?.picture as string}
                    alt=""
                  />
                  <AvatarFallback className="bg-muted">
                    <User className="h-5 w-5 text-muted-foreground" />
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {user?.name || 'User'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {user?.username || ''}
                  </p>
                </div>
              </div>
              <LogoutButton />
            </>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <Avatar className="h-9 w-9 cursor-default border border-border/60">
                    <AvatarImage
                      src={user?.idTokenClaims?.picture as string}
                      alt=""
                    />
                    <AvatarFallback className="bg-muted">
                      <User className="h-4 w-4 text-muted-foreground" />
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-[14rem]">
                  <p className="font-medium">{user?.name || 'Account'}</p>
                  {user?.username ? (
                    <p className="text-xs text-muted-foreground">{user.username}</p>
                  ) : null}
                </TooltipContent>
              </Tooltip>
              <LogoutButton iconOnly />
            </div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-col border-b border-border bg-card/40 px-4 py-3 backdrop-blur-sm sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                {page.title}
              </h2>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {page.subtitle}
              </p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2 sm:gap-3">
              <ThemeToggle />
              {currentPage === 'home' && sessionId && (
                <Button
                  onClick={() => setShareDialogOpen(true)}
                  variant="outline"
                  size="sm"
                  className="gap-2 rounded-lg shadow-xs"
                >
                  <Share2 className="h-4 w-4" aria-hidden />
                  Share analysis
                </Button>
              )}
              {onUploadNew && (
                <Button
                  onClick={onUploadNew}
                  variant="secondary"
                  size="sm"
                  className="gap-2 rounded-lg shadow-xs"
                >
                  <Upload className="h-4 w-4" aria-hidden />
                  New analysis
                </Button>
              )}
            </div>
          </div>
        </header>

        <main
          id="main-content"
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          tabIndex={-1}
        >
          {children}
        </main>
      </div>

      <ShareAnalysisDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        sessionId={sessionId}
        fileName={fileName}
      />
    </div>
  );
}
