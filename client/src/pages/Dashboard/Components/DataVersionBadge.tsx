/**
 * Wave WR10 (incremental refresh) · "Data: as of …" badge + rollback menu.
 *
 * Self-contained: fetches the refresh history for the session and, when a prior
 * version exists, offers "Roll back to <prior>". On rollback it restores the
 * prior data + answers + dashboard server-side, then calls `onRolledBack` so the
 * parent reloads. Renders nothing until the history resolves (so a fresh,
 * never-refreshed analysis shows no badge).
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, Clock, Loader2, Undo2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { refreshHistory, rollbackRefresh } from "@/lib/api/refresh";
import { CompareVersionsModal } from "./CompareVersionsModal";

export interface DataVersionBadgeProps {
  sessionId: string;
  onRolledBack: () => void | Promise<void>;
}

export function DataVersionBadge({ sessionId, onRolledBack }: DataVersionBadgeProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [compareOpen, setCompareOpen] = useState(false);
  const historyKey = ["refresh-history", sessionId];

  const { data } = useQuery({
    queryKey: historyKey,
    queryFn: () => refreshHistory(sessionId),
    staleTime: 30_000,
    retry: false,
  });

  const rollback = useMutation({
    mutationFn: () => rollbackRefresh(sessionId),
    onSuccess: async (r) => {
      toast({
        title: "Rolled back",
        description: r.restoredLabel
          ? `Restored ${r.restoredLabel}.`
          : "Restored the prior version.",
      });
      await qc.invalidateQueries({ queryKey: historyKey });
      await onRolledBack();
    },
    onError: (e) =>
      toast({
        title: "Couldn't roll back",
        description: e instanceof Error ? e.message : "Try again.",
        variant: "destructive",
      }),
  });

  // No history (feature off / never refreshed / error) → render nothing.
  if (!data || (!data.currentLabel && !data.canRollback)) return null;

  const currentLabel = data.currentLabel ?? `version ${data.currentVersion ?? ""}`.trim();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted transition"
            title="Data version"
          >
            {rollback.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clock className="h-3.5 w-3.5" />
            )}
            Data: {currentLabel}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Data version</DropdownMenuLabel>
          <DropdownMenuItem disabled className="opacity-100">
            ● {currentLabel} (current)
          </DropdownMenuItem>
          {data.canRollback ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCompareOpen(true)}>
                <ArrowLeftRight className="h-4 w-4 mr-2" />
                Compare {data.priorLabel ?? "prior"} vs {currentLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => rollback.mutate()}
                disabled={rollback.isPending}
              >
                <Undo2 className="h-4 w-4 mr-2" />
                Roll back to {data.priorLabel ?? "the prior version"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <CompareVersionsModal
        open={compareOpen}
        onOpenChange={setCompareOpen}
        sessionId={sessionId}
      />
    </>
  );
}
