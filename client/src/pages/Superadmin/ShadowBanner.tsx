import { Shield } from "lucide-react";

export function ShadowBanner({ ownerEmail }: { ownerEmail: string | null }) {
  return (
    <div className="sticky top-0 z-30 border-b border-border/60 bg-amber-500/10 backdrop-blur">
      <div className="container mx-auto px-4 py-2 flex items-center gap-2 text-xs">
        <Shield className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-foreground">Shadow mode</span>
        <span className="text-muted-foreground">
          — viewing
          {ownerEmail ? (
            <span className="ml-1 font-mono text-foreground">{ownerEmail}</span>
          ) : (
            " this session"
          )}{" "}
          as superadmin. Read-only.
        </span>
      </div>
    </div>
  );
}
