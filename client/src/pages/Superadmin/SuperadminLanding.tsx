import { useLocation } from "wouter";
import { useEffect } from "react";
import { useSuperadmin } from "@/auth/useSuperadmin";

/**
 * Landing page for /superadmin and the parent of the sessions / dashboards
 * tables (wired in W7+). Defence-in-depth: if a non-superadmin manages to
 * navigate here directly we redirect away. The navbar entry is hidden for
 * non-superadmins; this is the second guard.
 */
export default function SuperadminLanding() {
  const { isSuperadmin, isLoading } = useSuperadmin();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isSuperadmin) {
      setLocation("/analysis");
    }
  }, [isLoading, isSuperadmin, setLocation]);

  if (isLoading || !isSuperadmin) return null;

  return (
    <div className="container mx-auto py-8 px-6">
      <p className="text-sm text-muted-foreground">
        Choose a surface to inspect. Sessions and dashboards are read-only —
        you can browse every user's chat exactly as they would see it, but
        you cannot send messages or edit dashboards.
      </p>
      <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <button
          type="button"
          onClick={() => setLocation("/superadmin/sessions")}
          className="rounded-brand-md border border-border/60 bg-card p-6 text-left hover:bg-muted/30 transition"
        >
          <div className="text-sm font-semibold text-foreground">All sessions</div>
          <p className="text-xs text-muted-foreground mt-1">
            Every chat ever, with feedback summary badges and links into the
            full session.
          </p>
        </button>
        <button
          type="button"
          onClick={() => setLocation("/superadmin/dashboards")}
          className="rounded-brand-md border border-border/60 bg-card p-6 text-left hover:bg-muted/30 transition"
        >
          <div className="text-sm font-semibold text-foreground">All dashboards</div>
          <p className="text-xs text-muted-foreground mt-1">
            Every saved dashboard, scoped per user.
          </p>
        </button>
      </div>
    </div>
  );
}
