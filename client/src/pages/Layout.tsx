import { useState } from 'react';
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

interface LayoutProps {
  children: React.ReactNode;
  currentPage: 'home' | 'dashboard' | 'analysis';
  onNavigate: (page: 'home' | 'dashboard' | 'analysis') => void;
  onNewChat: () => void;
  onUploadNew?: () => void;
  sessionId?: string;
  fileName?: string;
}

const PAGE_COPY: Record<
  LayoutProps['currentPage'],
  { title: string; subtitle: string }
> = {
  home: {
    title: 'Chats',
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

export function Layout({
  children,
  currentPage,
  onNavigate,
  onNewChat: _onNewChat,
  onUploadNew,
  sessionId,
  fileName,
}: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const { user } = useAuth();

  const navigationItems = [
    {
      id: 'home' as const,
      label: 'Chats',
      icon: MessageSquare,
      description: 'Conversations',
    },
    {
      id: 'dashboard' as const,
      label: 'Dashboard',
      icon: BarChart3,
      description: 'Saved boards',
    },
    {
      id: 'analysis' as const,
      label: 'Analysis',
      icon: TrendingUp,
      description: 'Session history',
    },
  ];

  const page = PAGE_COPY[currentPage];

  const NavButton = (props: {
    item: (typeof navigationItems)[0];
    isActive: boolean;
  }) => {
    const { item, isActive } = props;
    const Icon = item.icon;
    const button = (
      <Button
        id={`nav-${item.id}`}
        onClick={() => onNavigate(item.id)}
        variant={isActive ? 'default' : 'ghost'}
        aria-current={isActive ? 'page' : undefined}
        aria-label={
          !sidebarOpen ? `${item.label} — ${item.description}` : undefined
        }
        className={cn(
          'min-h-11 w-full justify-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-200 motion-reduce:transition-none',
          isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-sidebar-foreground hover:bg-sidebar-accent/80',
          !sidebarOpen && 'justify-center px-0'
        )}
      >
        <Icon className="h-5 w-5 shrink-0" aria-hidden />
        {sidebarOpen && (
          <div className="flex min-w-0 flex-col items-start text-start">
            <span className="font-medium leading-none">{item.label}</span>
            <span className="mt-1 text-xs opacity-80">{item.description}</span>
          </div>
        )}
      </Button>
    );

    if (!sidebarOpen) {
      return (
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-[14rem] font-normal">
            <p className="font-medium">{item.label}</p>
            <p className="text-xs text-muted-foreground">{item.description}</p>
          </TooltipContent>
        </Tooltip>
      );
    }

    return button;
  };

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
              <p className="truncate text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Marico
              </p>
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
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

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label="App sections">
          {navigationItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              isActive={currentPage === item.id}
            />
          ))}
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
