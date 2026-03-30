import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  LogIn,
  User,
  Mail,
  Building,
  Shield,
  Loader2,
  CheckCircle,
} from 'lucide-react';
import { AppLoadingScreen } from '@/components/AppLoadingScreen';

const Login: React.FC = () => {
  const { user, isAuthenticated, isLoading, login, logout } = useAuth();

  if (isLoading) {
    return <AppLoadingScreen message="Loading authentication…" />;
  }

  if (isAuthenticated && user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/40 to-background p-4">
        <Card className="w-full max-w-md border-border/80 shadow-lg">
          <CardHeader className="text-center">
            <div className="mb-4 flex justify-center">
              <Avatar className="h-16 w-16 border border-border/60">
                <AvatarImage src={user.idTokenClaims?.picture as string} alt="" />
                <AvatarFallback className="bg-muted">
                  <User className="h-8 w-8 text-muted-foreground" />
                </AvatarFallback>
              </Avatar>
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight">
              Welcome back
            </CardTitle>
            <CardDescription>
              Signed in with Microsoft Azure AD
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-muted/40 p-3">
                <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <p className="font-medium text-foreground">Identity verified</p>
                  <p className="text-sm text-muted-foreground">
                    Your session is active and secure.
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium text-muted-foreground">Name</span>
                  <span className="min-w-0 truncate text-foreground">{user.name}</span>
                </div>

                {user.username && (
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium text-muted-foreground">Email</span>
                    <span className="min-w-0 truncate text-foreground">{user.username}</span>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Shield className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium text-muted-foreground">Provider</span>
                  <Badge variant="secondary" className="text-xs">
                    Azure AD
                  </Badge>
                </div>
              </div>
            </div>

            <div className="pt-2">
              <Button
                onClick={logout}
                variant="outline"
                className="w-full rounded-lg"
                disabled={isLoading}
              >
                <LogIn className="mr-2 h-4 w-4" />
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/40 to-background p-4">
      <Card className="w-full max-w-md border-border/80 shadow-lg">
        <CardHeader className="text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
              <Building className="h-8 w-8 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            Marico Insight
          </CardTitle>
          <CardDescription className="text-base">
            Sign in with your Azure AD account to continue
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-muted/40 p-3">
              <Shield className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="font-medium text-foreground">Enterprise sign-in</p>
                <p className="text-sm text-muted-foreground">
                  You will be redirected to Microsoft to authenticate.
                </p>
              </div>
            </div>

            <p className="text-center text-xs text-muted-foreground">
              By continuing, you agree to your organization&apos;s policies for this application.
            </p>
          </div>

          <Button
            onClick={login}
            className="w-full rounded-lg"
            disabled={isLoading}
            size="lg"
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                Opening Microsoft…
              </>
            ) : (
              <>
                <LogIn className="mr-2 h-4 w-4" />
                Sign in with Azure AD
              </>
            )}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Need help? Contact your administrator.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default Login;
