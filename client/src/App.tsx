import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, Suspense, lazy } from "react";
import { Switch, Route, useLocation, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { sessionsApi } from "@/lib/api";
import { getUserEmail } from "@/utils/userStorage";
import type { SessionsResponse } from "@/pages/Analysis/types";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/pages/Layout";
import { ChatSidebarNavProvider } from "@/contexts/ChatSidebarNavContext";
import { DashboardProvider } from "@/pages/Dashboard/context/DashboardContext";
import { AuthProvider } from "@/contexts/AuthContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AuthCallback from "@/components/AuthCallback";
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { createMsalConfig } from '@/auth/msalConfig';
import { registerMsalInstance } from '@/auth/msalToken';
import { logger } from "@/lib/logger";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/components/theme-provider";
import { AppLoadingScreen } from "@/components/AppLoadingScreen";

// Lazy load route components for code splitting
const Home = lazy(() => import("@/pages/Home/Home"));
const Dashboard = lazy(() => import("@/pages/Dashboard/Dashboard"));
const Analysis = lazy(() => import("@/pages/Analysis/Analysis"));
const AnalysisMemory = lazy(
  () => import("@/pages/AnalysisMemory/AnalysisMemory")
);
const AdminCosts = lazy(() => import("@/pages/Admin/AdminCosts"));
const AdminContextPacks = lazy(() => import("@/pages/Admin/AdminContextPacks"));
const NotFound = lazy(() => import("@/pages/NotFound/not-found"));
const Explore = lazy(() => import("@/pages/Explore/Explore"));
const SuperadminLanding = lazy(
  () => import("@/pages/Superadmin/SuperadminLanding")
);
const SuperadminSessionsPage = lazy(
  () => import("@/pages/Superadmin/SuperadminSessionsPage")
);
const SuperadminSessionViewer = lazy(
  () => import("@/pages/Superadmin/SuperadminSessionViewer")
);
const SuperadminDashboardsPage = lazy(
  () => import("@/pages/Superadmin/SuperadminDashboardsPage")
);
const SuperadminDashboardViewer = lazy(
  () => import("@/pages/Superadmin/SuperadminDashboardViewer")
);

const RouteLoadingFallback = () => (
  <AppLoadingScreen variant="embedded" message="Loading workspace…" />
);

type PageType = 'home' | 'dashboard' | 'analysis' | 'memory' | 'superadmin';

function Router() {
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const [location, setLocation] = useLocation();
  const [resetTrigger, setResetTrigger] = useState(0);
  const [loadedSessionData, setLoadedSessionData] = useState<any>(null);
  // The URL is the single source of truth for sessionId. App keeps no mirror.
  // Two small bits of UX-hint state:
  //   • `lastChatSessionId` — remembered so the "Chat" tab re-opens the most
  //     recently visited session when clicked from /dashboard or /history.
  //     Not authoritative; safe to be stale.
  //   • `lastChatFileName` — only used by Layout for the page title.
  const [lastChatSessionId, setLastChatSessionId] = useState<string | null>(null);
  const [lastChatFileName, setLastChatFileName] = useState<string | null>(null);

  // Extract page type from location
  const getCurrentPage = (): PageType => {
    if (location.startsWith('/superadmin')) return 'superadmin';
    if (location.startsWith('/dashboard')) return 'dashboard';
    if (location === '/history' || location.startsWith('/history')) return 'analysis';
    // W62 · Memory page is session-scoped: /analysis/:sessionId/memory.
    if (/^\/analysis\/[^/]+\/memory/.test(location)) return 'memory';
    // For /analysis and any chat interface routes - return 'home'
    return 'home';
  };

  // The chat surface lives at `/analysis` (no session) or `/analysis/:sessionId`.
  // `/analysis/:sessionId/memory` is a different page and must not match here.
  const urlSessionId = useMemo(() => {
    const m = location.match(/^\/analysis\/([^/]+)$/);
    return m?.[1] ?? null;
  }, [location]);

  const handleNavigate = (page: PageType) => {
    if (page === 'home') {
      // Preserve the active session so Chat → Dashboard → Chat resumes in place.
      // Reads the URL first; falls back to lastChatSessionId only when
      // we're navigating in from a non-/analysis surface.
      const target = urlSessionId ?? lastChatSessionId;
      setLocation(target ? `/analysis/${target}` : '/analysis');
    } else if (page === 'dashboard') {
      setLocation('/dashboard');
    } else if (page === 'analysis') {
      // Navigate to analysis history page
      setLocation('/history');
    } else if (page === 'memory') {
      // W62 · only meaningful when a session is active.
      const target = urlSessionId ?? lastChatSessionId;
      if (target) {
        setLocation(`/analysis/${target}/memory`);
      }
    } else if (page === 'superadmin') {
      setLocation('/superadmin');
    }
  };

  const handleNewChat = () => {
    // Strict 1:1 with sessionId: always start at bare `/analysis` so the
    // next upload/Snowflake import mints a fresh sessionId. The Home
    // remount key (below) discards any stale internal state.
    setLocation('/analysis');
    setLoadedSessionData(null);
    setLastChatSessionId(null);
    setLastChatFileName(null);
  };

  const handleUploadNew = () => {
    // Same as handleNewChat plus a resetTrigger bump so Home auto-opens
    // the file picker on the fresh mount.
    setLocation('/analysis');
    setResetTrigger(prev => prev + 1);
    setLoadedSessionData(null);
    setLastChatSessionId(null);
    setLastChatFileName(null);
  };

  const handleLoadSession = (sessionId: string, sessionData: any) => {
    logger.log('🔄 Loading session in App:', sessionId, sessionData);
    // Clear resetTrigger to prevent file dialog from opening when loading a session
    setResetTrigger(0);
    setLoadedSessionData(sessionData);
    // Reflect the active session in the URL so navigating away/back resumes it.
    setLocation(`/analysis/${sessionId}`);
  };

  // Redirect root and old (/data-ops, /modeling) routes to /analysis.
  // Guard against re-invoking setLocation when already on target (P-045).
  // Legacy paths kept for bookmark-compat (P-072).
  useEffect(() => {
    const isLegacy =
      location === '/' || location === '/data-ops' || location === '/modeling';
    if (isLegacy && location !== '/analysis') {
      setLocation('/analysis');
    }
  }, [location, setLocation]);

  // Warm sessions cache as early as possible so the Analysis sidebar opens instantly.
  useLayoutEffect(() => {
    if (!userEmail) return;
    void queryClient.prefetchQuery({
      queryKey: ['sessions', userEmail],
      queryFn: () => sessionsApi.getAllSessions() as Promise<SessionsResponse>,
    });
  }, [userEmail, queryClient]);

  const currentPage = getCurrentPage();

  // Layout reads the active sessionId from the URL. Memory is also
  // session-scoped: /analysis/:sessionId/memory.
  const sessionIdForLayout = useMemo(() => {
    if (urlSessionId) return urlSessionId;
    const m = location.match(/^\/analysis\/([^/]+)\/memory\/?$/);
    return m?.[1] ?? null;
  }, [urlSessionId, location]);

  // Track whichever session was last viewed so the Chat tab can resume it
  // when the user is on /dashboard or /history. Pure UX hint — never read
  // as authoritative.
  useEffect(() => {
    if (urlSessionId) setLastChatSessionId(urlSessionId);
  }, [urlSessionId]);

  // Home reports its current sessionId / fileName. Two responsibilities:
  //   1. Sync the URL when a fresh upload/Snowflake import mints a
  //      sessionId (URL was bare `/analysis`).
  //   2. Track fileName for the layout title.
  // App holds no mirror state for sessionId — the URL is the truth.
  //
  // `selfMintedSessionRef` tags the sessionId we just wrote to the URL so
  // the rehydration effect doesn't double-fetch (the doc may not yet
  // exist on the server during an in-flight upload). Consumed once.
  const selfMintedSessionRef = useRef<string | null>(null);
  const handleSessionChange = (sessionId: string | null, fileName: string | null) => {
    setLastChatFileName(fileName);
    if (sessionId && !urlSessionId && location.startsWith('/analysis')) {
      selfMintedSessionRef.current = sessionId;
      setLocation(`/analysis/${sessionId}`, { replace: true });
    }
  };

  // `homeKey` forces a clean Home remount whenever the active session
  // identity changes via navigation (sidebar click, browser back/forward,
  // New Analysis), but **not** when an upload mints a new sessionId on
  // an in-flight Home (null → real). Otherwise the freshly-uploaded
  // preview state would be wiped the moment the URL flips to /analysis/:id.
  const [homeKey, setHomeKey] = useState(0);
  const prevUrlSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevUrlSessionIdRef.current;
    prevUrlSessionIdRef.current = urlSessionId;
    if (prev === urlSessionId) return;
    if (prev === null && urlSessionId !== null) return; // upload-driven; preserve state
    setHomeKey((k) => k + 1);
  }, [urlSessionId]);

  // Rehydrate from server when arriving at `/analysis/:sessionId` without
  // a loaded snapshot. Skips when the snapshot already matches the URL,
  // or when this URL was just minted by an in-flight Home upload (the
  // server doc may not exist yet — fetching would 404 and bounce us
  // back to /analysis).
  useEffect(() => {
    if (!urlSessionId) return;
    if (selfMintedSessionRef.current === urlSessionId) {
      selfMintedSessionRef.current = null; // consume
      return;
    }
    if (loadedSessionData?.session?.sessionId === urlSessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const details = await sessionsApi.getSessionDetails(urlSessionId);
        if (cancelled) return;
        setLoadedSessionData(details);
      } catch (err) {
        if (cancelled) return;
        logger.warn('Failed to rehydrate session from URL', err);
        setLoadedSessionData(null);
        setLocation('/analysis', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [urlSessionId, loadedSessionData, setLocation]);

  return (
    <ChatSidebarNavProvider>
      <Layout
        currentPage={currentPage}
        onNavigate={handleNavigate}
        onNewChat={handleNewChat}
        onUploadNew={handleUploadNew}
        onLoadSession={handleLoadSession}
        sessionId={sessionIdForLayout}
        fileName={lastChatFileName}
      >
        <Suspense fallback={<RouteLoadingFallback />}>
          <Switch>
            <Route path="/history">
              <Analysis onNavigate={handleNavigate} onNewChat={handleNewChat} onLoadSession={handleLoadSession} onUploadNew={handleUploadNew} />
            </Route>
            <Route path="/dashboard">
              <Dashboard />
            </Route>
            <Route path="/analysis/:sessionId/memory">
              <AnalysisMemory />
            </Route>
            <Route path="/analysis/:sessionId?">
              <Home
                key={homeKey}
                resetTrigger={resetTrigger}
                loadedSessionData={loadedSessionData}
                onSessionChange={handleSessionChange}
                urlSessionId={urlSessionId}
              />
            </Route>
            <Route path="/admin/costs">
              <AdminCosts />
            </Route>
            <Route path="/admin/context-packs">
              <AdminContextPacks />
            </Route>
            <Route path="/explore">
              <Explore />
            </Route>
            <Route path="/superadmin/sessions/:sessionId">
              <SuperadminSessionViewer />
            </Route>
            <Route path="/superadmin/sessions">
              <SuperadminSessionsPage />
            </Route>
            <Route path="/superadmin/dashboards/:dashboardId">
              <SuperadminDashboardViewer />
            </Route>
            <Route path="/superadmin/dashboards">
              <SuperadminDashboardsPage />
            </Route>
            <Route path="/superadmin">
              <SuperadminLanding />
            </Route>
            <Route>
              <NotFound />
            </Route>
          </Switch>
        </Suspense>
      </Layout>
    </ChatSidebarNavProvider>
  );
}

// Component to handle authentication redirects. P-065: compute the redirect
// flag synchronously from the URL so we never flash both branches while an
// async setState settles.
function AuthRedirectHandler() {
  const isHandlingRedirect = (() => {
    if (typeof window === 'undefined') return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.has('code') || urlParams.has('error');
  })();

  if (isHandlingRedirect) {
    return <AuthCallback />;
  }

  return (
    <WouterRouter>
      <Router />
    </WouterRouter>
  );
}

// P-016: Lazy singleton instead of top-level construction. Module re-parse
// during HMR (or second import via code-split chunks) previously instantiated
// a second MSAL client and silently invalidated cached auth state.
let cachedMsalInstance: PublicClientApplication | null = null;
function getMsalInstance(): PublicClientApplication {
  if (!cachedMsalInstance) {
    cachedMsalInstance = new PublicClientApplication(createMsalConfig());
    registerMsalInstance(cachedMsalInstance);
  }
  return cachedMsalInstance;
}

function App() {
  const msalInstance = getMsalInstance();
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MsalProvider instance={msalInstance}>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <AuthProvider>
                <ProtectedRoute>
                  <DashboardProvider>
                    <Toaster />
                    <ErrorBoundary>
                      <AuthRedirectHandler />
                    </ErrorBoundary>
                  </DashboardProvider>
                </ProtectedRoute>
              </AuthProvider>
            </TooltipProvider>
          </QueryClientProvider>
        </MsalProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
