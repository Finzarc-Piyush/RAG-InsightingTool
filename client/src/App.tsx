import React, { useState, useEffect, useLayoutEffect, Suspense, lazy } from "react";
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
const NotFound = lazy(() => import("@/pages/NotFound/not-found"));

const RouteLoadingFallback = () => (
  <AppLoadingScreen variant="embedded" message="Loading workspace…" />
);

type PageType = 'home' | 'dashboard' | 'analysis';

function Router() {
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const [location, setLocation] = useLocation();
  const [resetTrigger, setResetTrigger] = useState(0);
  const [loadedSessionData, setLoadedSessionData] = useState<any>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentFileName, setCurrentFileName] = useState<string | null>(null);

  // Extract page type from location
  const getCurrentPage = (): PageType => {
    if (location.startsWith('/dashboard')) return 'dashboard';
    if (location === '/history' || location.startsWith('/history')) return 'analysis';
    // For /analysis and any chat interface routes - return 'home'
    return 'home';
  };

  const handleNavigate = (page: PageType) => {
    if (page === 'home') {
      // Navigate to chat interface (always /analysis)
      setLocation('/analysis');
    } else if (page === 'dashboard') {
      setLocation('/dashboard');
    } else if (page === 'analysis') {
      // Navigate to analysis history page
      setLocation('/history');
    }
  };

  const handleNewChat = () => {
    // Always navigate to /analysis regardless of mode
    setLocation('/analysis');
    setLoadedSessionData(null);
    setCurrentSessionId(null);
    setCurrentFileName(null);
  };

  const handleUploadNew = () => {
    // Always navigate to /analysis regardless of mode
    setLocation('/analysis');
    setResetTrigger(prev => prev + 1);
    setLoadedSessionData(null);
    setCurrentSessionId(null);
    setCurrentFileName(null);
  };

  const handleLoadSession = (sessionId: string, sessionData: any) => {
    logger.log('🔄 Loading session in App:', sessionId, sessionData);
    // Clear resetTrigger to prevent file dialog from opening when loading a session
    setResetTrigger(0);
    setLoadedSessionData(sessionData);
    // Navigate to chat interface (always /analysis)
    setLocation('/analysis');
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

  const handleSessionChange = (sessionId: string | null, fileName: string | null) => {
    setCurrentSessionId(sessionId);
    setCurrentFileName(fileName);
  };

  return (
    <ChatSidebarNavProvider>
      <Layout
        currentPage={currentPage}
        onNavigate={handleNavigate}
        onNewChat={handleNewChat}
        onUploadNew={handleUploadNew}
        onLoadSession={handleLoadSession}
        sessionId={currentSessionId}
        fileName={currentFileName}
      >
        <Suspense fallback={<RouteLoadingFallback />}>
          <Switch>
            <Route path="/history">
              <Analysis onNavigate={handleNavigate} onNewChat={handleNewChat} onLoadSession={handleLoadSession} onUploadNew={handleUploadNew} />
            </Route>
            <Route path="/dashboard">
              <Dashboard />
            </Route>
            <Route path="/analysis">
              <Home
                resetTrigger={resetTrigger}
                loadedSessionData={loadedSessionData}
                onSessionChange={handleSessionChange}
              />
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

// Component to handle authentication redirects
function AuthRedirectHandler() {
  const [isHandlingRedirect, setIsHandlingRedirect] = useState(true);

  useEffect(() => {
    // Check if we're handling a redirect
    const urlParams = new URLSearchParams(window.location.search);
    const isRedirect = urlParams.has('code') || urlParams.has('error');
    
    if (isRedirect) {
      // We're in a redirect flow, show the callback component
      setIsHandlingRedirect(true);
    } else {
      // Normal app flow
      setIsHandlingRedirect(false);
    }
  }, []);

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
