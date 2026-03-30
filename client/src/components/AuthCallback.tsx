import React, { useEffect } from 'react';
import { useMsal } from '@azure/msal-react';
import { AppLoadingScreen } from '@/components/AppLoadingScreen';

const AuthCallback: React.FC = () => {
  const { instance } = useMsal();

  useEffect(() => {
    const handleRedirect = async () => {
      try {
        // Handle the redirect response
        const response = await instance.handleRedirectPromise();
        if (response) {
          console.log('Authentication successful:', response);
          // The AuthContext will automatically update the user state
        }
      } catch (error) {
        console.error('Authentication failed:', error);
      }
    };

    handleRedirect();
  }, [instance]);

  return <AppLoadingScreen message="Completing sign-in…" />;
};

export default AuthCallback;
