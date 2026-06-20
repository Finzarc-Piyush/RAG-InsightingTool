/**
 * Wave WR13 (incremental refresh) · Snowflake auto-refresh schedule.
 *
 * A small Off / Daily / Weekly chooser for a Snowflake-connected analysis. A
 * Vercel cron re-queries the table on the chosen interval and regenerates. The
 * cadence is per-session; the cron only touches sessions that are due.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { setRefreshSchedule } from "@/lib/api/refresh";

export interface ScheduleRefreshDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
}

type Choice = "off" | "daily" | "weekly";
const INTERVAL: Record<Exclude<Choice, "off">, number> = { daily: 24, weekly: 168 };

export function ScheduleRefreshDialog({
  open,
  onOpenChange,
  sessionId,
}: ScheduleRefreshDialogProps) {
  const { toast } = useToast();
  const [choice, setChoice] = useState<Choice>("off");

  const save = useMutation({
    mutationFn: () =>
      setRefreshSchedule(sessionId, {
        enabled: choice !== "off",
        intervalHours: choice === "off" ? undefined : INTERVAL[choice],
      }),
    onSuccess: () => {
      toast({
        title: "Schedule saved",
        description:
          choice === "off"
            ? "Auto-refresh turned off."
            : `This analysis will auto-refresh ${choice}.`,
      });
      onOpenChange(false);
    },
    onError: (e) =>
      toast({
        title: "Couldn't save schedule",
        description: e instanceof Error ? e.message : "Try again.",
        variant: "destructive",
      }),
  });

  const options: { v: Choice; label: string; sub: string }[] = [
    { v: "off", label: "Off", sub: "Update manually only." },
    { v: "daily", label: "Daily", sub: "Re-query Snowflake once a day." },
    { v: "weekly", label: "Weekly", sub: "Re-query Snowflake once a week." },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Auto-refresh from Snowflake</DialogTitle>
          <DialogDescription>
            Keep this analysis current automatically by re-querying its table on a
            schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          {options.map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setChoice(o.v)}
              className={`w-full text-left rounded-lg border p-3 transition ${
                choice === o.v
                  ? "border-primary ring-1 ring-primary bg-primary/5"
                  : "border-border hover:bg-muted/50"
              }`}
            >
              <div className="font-medium text-sm flex items-center gap-2">
                {choice === o.v && <CheckCircle2 className="h-4 w-4 text-primary" />}
                {o.label}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{o.sub}</div>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
