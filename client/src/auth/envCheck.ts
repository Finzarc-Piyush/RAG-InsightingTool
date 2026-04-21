// Environment variables check
import { logger } from '@/lib/logger';

export const checkEnvironmentVariables = () => {
  const requiredVars = [
    'VITE_AZURE_CLIENT_ID',
    'VITE_AZURE_TENANT_ID'
  ];

  const missingVars = requiredVars.filter(varName => !import.meta.env[varName]);

  if (missingVars.length > 0) {
    logger.error('Missing required environment variables:', missingVars);
    logger.error('Please check client/client.env and ensure all required variables are set.');
    return false;
  }

  logger.log('✅ All required environment variables are set');
  logger.log('Client ID:', import.meta.env.VITE_AZURE_CLIENT_ID ? 'Set' : 'Missing');
  logger.log('Tenant ID:', import.meta.env.VITE_AZURE_TENANT_ID ? 'Set' : 'Missing');
  logger.log('Redirect URI:', import.meta.env.VITE_AZURE_REDIRECT_URI || 'Using default (http://localhost:3000)');
  logger.log('Post-logout Redirect URI:', import.meta.env.VITE_AZURE_POST_LOGOUT_REDIRECT_URI || 'Using dynamic origin');

  return true;
};
