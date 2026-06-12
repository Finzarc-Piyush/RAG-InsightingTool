import React, { useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { AppLoadingScreen } from '@/components/AppLoadingScreen';
import { logger } from "@/lib/logger";

const AuthCallback: React.FC = () => {
  const { instance } = useMsal();

  useEffect(() => {
    const handleRedirect = async () => {
      try {
        // Handle the redirect response
        const response = await instance.handleRedirectPromise();
        if (response) {
          logger.log('Authentication successful:', response);
          // The AuthContext will automatically update the user state
        }
      } catch (error) {
        logger.error('Authentication failed:', error);
      }
    };

    handleRedirect();
  }, [instance]);

  return <AppLoadingScreen message="Completing sign-in…" />;
};

export default AuthCallback;
