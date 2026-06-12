import { logger } from "@/lib/logger";
// Utility functions for managing user data in localStorage

export const getUserEmail = (): string | null => {
  try {
    return localStorage.getItem('userEmail');
  } catch (error) {
    logger.error('Error getting user email from localStorage:', error);
    return null;
  }
};

export const setUserEmail = (email: string): void => {
  try {
    localStorage.setItem('userEmail', email);
    logger.log('User email saved to localStorage:', email);
  } catch (error) {
    logger.error('Error saving user email to localStorage:', error);
  }
};

export const clearUserEmail = (): void => {
  try {
    localStorage.removeItem('userEmail');
    logger.log('User email removed from localStorage');
  } catch (error) {
    logger.error('Error clearing user email from localStorage:', error);
  }
};

export const isUserEmailStored = (): boolean => {
  return getUserEmail() !== null;
};
