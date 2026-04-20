import { Configuration, PopupRequest } from '@azure/msal-browser';
import { checkEnvironmentVariables } from './envCheck';

// Check environment variables on import
checkEnvironmentVariables();

// MSAL configuration factory - creates config at runtime
export const createMsalConfig = (): Configuration => {
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  
  console.log('🔧 Creating MSAL config with origin:', currentOrigin);
  console.log('🔧 Environment VITE_AZURE_POST_LOGOUT_REDIRECT_URI:', import.meta.env.VITE_AZURE_POST_LOGOUT_REDIRECT_URI);
  console.log('🔧 Final postLogoutRedirectUri:', import.meta.env.VITE_AZURE_POST_LOGOUT_REDIRECT_URI || currentOrigin);
  
  return {
    auth: {
      clientId: import.meta.env.VITE_AZURE_CLIENT_ID || '',
      authority: `https://login.microsoftonline.com/${import.meta.env.VITE_AZURE_TENANT_ID || ''}`,
      redirectUri: import.meta.env.VITE_AZURE_REDIRECT_URI || currentOrigin,
      postLogoutRedirectUri: import.meta.env.VITE_AZURE_POST_LOGOUT_REDIRECT_URI || currentOrigin,
    },
    cache: {
      cacheLocation: 'sessionStorage', // This configures where your cache will be stored
      storeAuthStateInCookie: false,
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) {
            return;
          }
          switch (level) {
            case 0: // LogLevel.Error
              console.error(message);
              return;
            case 1: // LogLevel.Warning
              console.warn(message);
              return;
            case 2: // LogLevel.Info
              console.info(message);
              return;
            case 3: // LogLevel.Verbose
              console.debug(message);
              return;
            default:
              return;
          }
        },
      },
    },
  };
};

// Add scopes here for ID token to be used at Microsoft identity platform endpoints.
export const loginRequest = {
  scopes: ['User.Read'],
  prompt: 'select_account',
};

// Add the endpoints here for Microsoft Graph API services you'd like to use.
export const graphConfig = {
  graphMeEndpoint: 'https://graph.microsoft.com/v1.0/me',
};
