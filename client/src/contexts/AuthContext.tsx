import React, { createContext, useContext, useEffect, useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { AccountInfo, AuthenticationResult } from '@azure/msal-browser';
import { setUserEmail, clearUserEmail } from '@/utils/userStorage';
import { logger } from '@/lib/logger';

interface AuthContextType {
  user: AccountInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

// HMR-resilient singleton — see DashboardContext.tsx for rationale.
const AUTH_CONTEXT_KEY = "__MARICO_AUTH_CONTEXT_V1__";
const AuthContext: React.Context<AuthContextType | undefined> =
  ((globalThis as Record<string, unknown>)[AUTH_CONTEXT_KEY] as
    | React.Context<AuthContextType | undefined>
    | undefined) ??
  ((globalThis as Record<string, unknown>)[AUTH_CONTEXT_KEY] = createContext<
    AuthContextType | undefined
  >(undefined)) as React.Context<AuthContextType | undefined>;

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: React.ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const { instance, accounts, inProgress } = useMsal();
  const [user, setUser] = useState<AccountInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user;

  // Debug: Log authentication state changes
  useEffect(() => {
    logger.log('🔐 Auth state changed:', {
      accountsCount: accounts.length,
      user: user?.username,
      isAuthenticated,
      inProgress
    });
  }, [accounts.length, user?.username, isAuthenticated, inProgress]);

  useEffect(() => {
    if (accounts.length > 0) {
      const userAccount = accounts[0];
      setUser(userAccount);

      // Store user email in localStorage when user is authenticated
      if (userAccount.username) {
        setUserEmail(userAccount.username);
        logger.log('✅ User email stored in localStorage:', userAccount.username);
      }

      setIsLoading(false);
    } else if (inProgress === 'none') {
      setIsLoading(false);
    }
  }, [accounts, inProgress]);

  // P-013: failsafe — if MSAL gets wedged in a non-terminal inProgress state
  // with no accounts (e.g. popup blocked, stalled handleRedirectPromise), the
  // loading screen would never clear. Force-clear after a sensible budget so
  // the user at least sees the login path.
  useEffect(() => {
    if (!isLoading) return;
    const timer = setTimeout(() => {
      logger.warn('⚠️ AuthContext isLoading failsafe tripped after 5s');
      setIsLoading(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, [isLoading]);

  const login = async () => {
    try {
      setIsLoading(true);
      // Use redirect instead of popup to avoid CORS issues
      await instance.loginRedirect({
        scopes: ['User.Read'],
        prompt: 'select_account',
      });
    } catch (error) {
      logger.error('Login failed:', error);
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      setIsLoading(true);
      
      // Clear user data immediately
      setUser(null);
      clearUserEmail();
      
      const currentOrigin = window.location.origin;
      logger.log('🔧 Logout redirecting to:', currentOrigin);
      
      // Use logoutRedirect with explicit postLogoutRedirectUri
      await instance.logoutRedirect({
        postLogoutRedirectUri: currentOrigin,
        account: user || undefined,
      });
      
    } catch (error) {
      logger.error('Logout failed:', error);
      // If logout fails, still redirect to home page
      setTimeout(() => {
        window.location.href = window.location.origin;
      }, 1000);
    } finally {
      setIsLoading(false);
    }
  };

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isLoading,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
