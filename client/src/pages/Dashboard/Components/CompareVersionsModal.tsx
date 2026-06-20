/**
 * Wave WR12 (incremental refresh) · April-vs-May compare.
 *
 * A focused delta view: per chart that exists in both versions, the prior total,
 * the current total, and the % change — the "Value sales +6.2%" a manager reads
 * first. Opened from the "Data: as of …" badge. Lightweight by design (numbers,
 * not two full chart renders) so it ships on top of the existing engine.
 */

import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowRight, Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { refreshCompare } from "@/lib/api/refresh";

export interface CompareVersionsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : `${n}`;

export function CompareVersionsModal({
  open,
  onOpenChange,
  sessionId,
}: CompareVersionsModalProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["refresh-compare", sessionId],
    queryFn: () => refreshCompare(sessionId),
    enabled: open,
    staleTime: 10_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Compare {data?.priorLabel ?? "prior"} → {data?.currentLabel ?? "current"}
          </DialogTitle>
          <DialogDescription>
            How each view changed between the two data versions.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Computing changes…
          </div>
        ) : !data?.available ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No comparable charts yet — refresh the data once to compare versions.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
            {data.rows.map((r, i) => {
              const up = r.delta >= 0;
              return (
                <div key={`${r.title}-${i}`} className="py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{r.title}</div>
                    <div className="text-xs text-muted-foreground tabular-nums flex items-center gap-1.5">
                      {fmt(r.priorTotal)}
                      <ArrowRight className="h-3 w-3" />
                      {fmt(r.currentTotal)}
                    </div>
                  </div>
                  <div
                    className={`flex items-center gap-1 text-sm font-medium tabular-nums ${
                      up ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                    }`}
                  >
                    {up ? (
                      <TrendingUp className="h-4 w-4" />
                    ) : (
                      <TrendingDown className="h-4 w-4" />
                    )}
                    {r.deltaPct == null
                      ? `${up ? "+" : ""}${fmt(r.delta)}`
                      : `${up ? "+" : ""}${r.deltaPct.toFixed(1)}%`}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
