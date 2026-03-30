import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { LogOut, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LogoutButtonProps {
  /** Icon-only for narrow / collapsed layouts */
  iconOnly?: boolean;
}

const LogoutButton: React.FC<LogoutButtonProps> = ({ iconOnly = false }) => {
  const { logout, isLoading } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      await logout();
    } catch (error) {
      console.error('Logout error:', error);
      setIsLoggingOut(false);
    }
  };

  const isProcessing = isLoading || isLoggingOut;

  if (iconOnly) {
    return (
      <Button
        type="button"
        onClick={handleLogout}
        variant="ghost"
        size="icon"
        disabled={isProcessing}
        className={cn(
          'h-10 w-10 rounded-lg text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
          'disabled:opacity-50'
        )}
        aria-label={isProcessing ? 'Signing out' : 'Sign out'}
      >
        {isProcessing ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <LogOut className="h-4 w-4" />
        )}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      onClick={handleLogout}
      variant="ghost"
      size="sm"
      disabled={isProcessing}
      className="w-full justify-start gap-2 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
    >
      {isProcessing ? (
        <>
          <Loader2 className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
          <span>Signing out…</span>
        </>
      ) : (
        <>
          <LogOut className="h-4 w-4 shrink-0" />
          <span>Sign out</span>
        </>
      )}
    </Button>
  );
};

export default LogoutButton;
