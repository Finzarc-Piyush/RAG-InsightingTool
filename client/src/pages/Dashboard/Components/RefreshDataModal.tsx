/**
 * Wave WR8 (incremental refresh) · the "Update data" flow.
 *
 * One modal drives the whole flow for both sources:
 *   file source:  pick file → preflight (diff + drift) → Replace/Append choice
 *                 → (resolve column drift via AutomationRemapDialog) → run → done
 *   snowflake:    confirm → run (a full re-query = Replace) → done
 *
 * Progress reuses the automation replay SSE events inline (preparing →
 * replaying → done/halted). On success the parent reloads the dashboard.
 */

import { useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Upload,
} from "lucide-react";
import { AutomationRemapDialog } from "@/components/AutomationRemapDialog";
import {
  refreshPreflight,
  runRefreshStream,
  runSnowflakeRefreshStream,
  type RefreshPreflightResult,
  type RefreshSseEvent,
} from "@/lib/api/refresh";
import type { AutomationColumnMapping } from "@/shared/schema";

export interface RefreshDataModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  source: "file" | "snowflake";
  /** The Snowflake table label, for the confirm copy. */
  snowflakeLabel?: string;
  /** Fired after a successful refresh so the parent reloads the dashboard. */
  onComplete: (result: { dashboardId?: string }) => void;
}

type Step = "pick" | "review" | "running" | "done" | "error";
type Policy = "replace" | "append";

interface RefreshProgress {
  kind: "preparing" | "replaying";
  step?: number;
  total?: number;
  detail?: string;
}

export function RefreshDataModal({
  open,
  onOpenChange,
  sessionId,
  source,
  snowflakeLabel,
  onComplete,
}: RefreshDataModalProps) {
  const [step, setStep] = useState<Step>(source === "snowflake" ? "review" : "pick");
  const [file, setFile] = useState<File | null>(null);
  const [preflight, setPreflight] = useState<RefreshPreflightResult | null>(null);
  const [policy, setPolicy] = useState<Policy>("replace");
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRemap, setShowRemap] = useState(false);
  const [confirmedMapping, setConfirmedMapping] =
    useState<AutomationColumnMapping | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);

  const reset = () => {
    setStep(source === "snowflake" ? "review" : "pick");
    setFile(null);
    setPreflight(null);
    setPolicy("replace");
    setProgress(null);
    setError(null);
    setBusy(false);
    setShowRemap(false);
    setConfirmedMapping(undefined);
  };

  const close = () => {
    abortRef.current?.abort();
    reset();
    onOpenChange(false);
  };

  const onPickFile = async (picked: File) => {
    setFile(picked);
    setBusy(true);
    setError(null);
    try {
      const pf = await refreshPreflight(sessionId, picked);
      setPreflight(pf);
      if (pf.recipe.empty) {
        setError(
          "This analysis has no answered questions to regenerate yet. Ask a question first."
        );
        setStep("error");
        return;
      }
      setStep("review");
    } catch (e) {
      setError((e as Error)?.message ?? "Couldn't read that file.");
      setStep("error");
    } finally {
      setBusy(false);
    }
  };

  const driftNeedsResolving = (): boolean => {
    const cm = preflight?.columnMapping;
    if (!cm) return false;
    return cm.unmatchable.length > 0 || cm.proposedMappings.length > 0;
  };

  const onEvent = (ev: RefreshSseEvent) => {
    switch (ev.type) {
      case "automation_progress":
        setProgress(
          ev.phase === "preparing_dataset"
            ? { kind: "preparing", detail: ev.detail }
            : { kind: "replaying", step: ev.step, total: ev.total, detail: ev.detail }
        );
        break;
      case "automation_halted":
        setError(ev.error);
        setStep("error");
        break;
      case "refresh_complete":
        if (ev.ok) {
          setStep("done");
          onComplete({ dashboardId: ev.dashboardId });
        } else if (step !== "error") {
          setError("The refresh could not be completed.");
          setStep("error");
        }
        break;
      default:
        break;
    }
  };

  const startRun = (mapping?: AutomationColumnMapping) => {
    setStep("running");
    setProgress({ kind: "preparing" });
    setError(null);
    const callbacks = {
      onEvent,
      onError: (e: Error) => {
        setError(e.message);
        setStep("error");
      },
    };
    if (source === "snowflake") {
      abortRef.current = runSnowflakeRefreshStream(sessionId, {}, callbacks);
    } else if (file) {
      abortRef.current = runRefreshStream(
        sessionId,
        {
          file,
          policy,
          columnMapping: mapping,
          appendKey: policy === "append" ? preflight?.appendKey : undefined,
        },
        callbacks
      );
    }
  };

  const onConfirmReview = () => {
    if (source === "file" && driftNeedsResolving()) {
      setShowRemap(true);
      return;
    }
    startRun(confirmedMapping);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const diff = preflight?.diff;
  const rowsAfter =
    policy === "append" ? diff?.rowsAfterAppend : diff?.rowsAfterReplace;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              Update data
            </DialogTitle>
            <DialogDescription>
              {source === "snowflake"
                ? "Re-query Snowflake and regenerate this analysis on the latest data."
                : "Bring in new data and regenerate every chart, insight, and the summary."}
            </DialogDescription>
          </DialogHeader>

          {/* PICK (file source) */}
          {step === "pick" && (
            <div className="py-6">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xls,.xlsx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onPickFile(f);
                }}
              />
              <Button
                variant="outline"
                className="w-full h-24 border-dashed"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy ? (
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-5 w-5 mr-2" />
                )}
                {busy ? "Reading file…" : "Choose an updated CSV or Excel file"}
              </Button>
            </div>
          )}

          {/* REVIEW */}
          {step === "review" && source === "file" && diff && (
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-3 gap-2 text-sm rounded-lg border border-border p-3">
                <div className="text-muted-foreground">Rows</div>
                <div className="text-right tabular-nums">{diff.rowsBefore.toLocaleString()}</div>
                <div className="text-right tabular-nums font-medium">
                  → {(rowsAfter ?? 0).toLocaleString()}
                </div>
                <div className="text-muted-foreground">Columns</div>
                <div className="text-right tabular-nums">{diff.columnsBefore}</div>
                <div className="text-right tabular-nums">
                  → {diff.columnsAfter}
                  {diff.columnsAfter === diff.columnsBefore ? " (same)" : ""}
                </div>
              </div>

              <div className="space-y-2">
                {(
                  [
                    {
                      v: "replace" as Policy,
                      title: "Replace",
                      sub: "This file is the complete, latest data. It supersedes the current data.",
                    },
                    {
                      v: "append" as Policy,
                      title: "Add to existing",
                      sub: `Add these rows on top of the current data → regenerate on the full combined dataset (${diff.rowsBefore.toLocaleString()} + ${diff.rowsAfterReplace.toLocaleString()}).`,
                    },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setPolicy(opt.v)}
                    className={`w-full text-left rounded-lg border p-3 transition ${
                      policy === opt.v
                        ? "border-primary ring-1 ring-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="font-medium text-sm flex items-center gap-2">
                      {policy === opt.v && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      {opt.title}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{opt.sub}</div>
                  </button>
                ))}
              </div>

              {driftNeedsResolving() && (
                <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  Some columns changed — you'll confirm how they map next.
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Regenerates {preflight?.recipe.turns} answer
                {preflight?.recipe.turns === 1 ? "" : "s"} and{" "}
                {preflight?.recipe.charts} chart
                {preflight?.recipe.charts === 1 ? "" : "s"}.
              </div>
            </div>
          )}

          {step === "review" && source === "snowflake" && (
            <div className="py-4 text-sm text-muted-foreground">
              Re-query{" "}
              <span className="font-medium text-foreground">
                {snowflakeLabel ?? "the connected table"}
              </span>{" "}
              and regenerate every chart, insight, and the summary on the latest
              data. This replaces the current data.
            </div>
          )}

          {/* RUNNING */}
          {step === "running" && (
            <div className="py-6 space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                <div className="text-sm">
                  {progress?.kind === "replaying"
                    ? `Regenerating · question ${progress.step} of ${progress.total}`
                    : "Preparing the new data…"}
                </div>
              </div>
              {progress?.kind === "replaying" && (
                <Progress
                  value={Math.round(
                    ((progress.step ?? 0) / Math.max(progress.total ?? 1, 1)) * 100
                  )}
                />
              )}
              {progress?.detail && (
                <div className="text-xs text-muted-foreground truncate">
                  {progress.detail}
                </div>
              )}
            </div>
          )}

          {/* DONE */}
          {step === "done" && (
            <div className="py-6 flex items-center gap-3 text-sm">
              <CheckCircle2 className="h-6 w-6 text-emerald-500" />
              <div>Updated. Your dashboard and insights now reflect the new data.</div>
            </div>
          )}

          {/* ERROR */}
          {step === "error" && (
            <div className="py-6 flex items-start gap-3 text-sm">
              <AlertTriangle className="h-6 w-6 text-destructive shrink-0" />
              <div>{error ?? "Something went wrong."}</div>
            </div>
          )}

          <DialogFooter>
            {step === "review" && (
              <>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button onClick={onConfirmReview}>
                  {source === "snowflake" ? "Fetch & update" : "Continue"}
                </Button>
              </>
            )}
            {step === "running" && (
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
            )}
            {(step === "done" || step === "error") && (
              <Button onClick={close}>Close</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Column-drift resolution — reuses the automation remap dialog verbatim. */}
      {preflight && (
        <AutomationRemapDialog
          open={showRemap}
          onOpenChange={setShowRemap}
          automationName="this analysis"
          dryRun={preflight.columnMapping}
          newDatasetColumns={preflight.newColumns}
          onConfirm={(mapping) => {
            setConfirmedMapping(mapping);
            setShowRemap(false);
            startRun(mapping);
          }}
        />
      )}
    </>
  );
}
