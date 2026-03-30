import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import Login from '@/pages/Login/Login';
import { AppLoadingScreen } from '@/components/AppLoadingScreen';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <AppLoadingScreen message="Checking authentication…" />
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
