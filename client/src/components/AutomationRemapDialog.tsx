/**
 * Wave A14 · Confirm-the-column-mapping dialog.
 *
 * Shown after the dry-run endpoint returns. The user reviews the
 * proposed saved-name → new-name mapping and confirms (or edits, or
 * cancels). On confirm, calls `onConfirm(finalMapping)` so the
 * replay-banner hook can start the SSE run.
 *
 * If the dry-run reports `unmatchable` columns, the Confirm button is
 * disabled until the user resolves them (manually entering a new-column
 * name) or cancels the run.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type {
  AutomationColumnMapping,
  AutomationDryRunResult,
} from "@/shared/schema";

export interface AutomationRemapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  automationName: string;
  /** Result from POST /api/automations/:id/dry-run. */
  dryRun: AutomationDryRunResult | null;
  loading?: boolean;
  /** Available column names in the new dataset (for editor autocomplete). */
  newDatasetColumns: string[];
  /** Final mapping the user agreed to → triggers replay. */
  onConfirm: (mapping: AutomationColumnMapping) => void;
}

const confidenceBadgeVariant = (
  c: "high" | "medium" | "low"
): "default" | "secondary" | "outline" =>
  c === "high" ? "default" : c === "medium" ? "secondary" : "outline";

export const AutomationRemapDialog = ({
  open,
  onOpenChange,
  automationName,
  dryRun,
  loading = false,
  newDatasetColumns,
  onConfirm,
}: AutomationRemapDialogProps) => {
  // Editable per-saved-column "what should this map to" state.
  // Identity (saved === new) when not in the map.
  const [edits, setEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !dryRun) {
      setEdits({});
      return;
    }
    // Seed from the dry-run proposals (only non-null suggestions).
    const seed: Record<string, string> = {};
    for (const p of dryRun.proposedMappings) {
      if (p.suggested && p.suggested.length > 0) {
        seed[p.saved] = p.suggested;
      }
    }
    setEdits(seed);
  }, [open, dryRun]);

  const updateEdit = (saved: string, value: string) => {
    setEdits((prev) => ({ ...prev, [saved]: value }));
  };

  // A saved column is RESOLVED if either:
  //   - it's in exactMatches (identity, no edit needed), OR
  //   - the user's edit value is a valid new-dataset column name.
  const validNewNames = new Set(newDatasetColumns);
  const unresolvedSavedNames: string[] = [];
  if (dryRun) {
    for (const name of dryRun.unmatchable) {
      const userValue = edits[name];
      if (
        !userValue ||
        userValue.length === 0 ||
        !validNewNames.has(userValue)
      ) {
        unresolvedSavedNames.push(name);
      }
    }
  }
  const canConfirm = !loading && unresolvedSavedNames.length === 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    // Build final mapping. Only emit non-identity entries.
    const final: AutomationColumnMapping = {};
    for (const [saved, target] of Object.entries(edits)) {
      if (target && target !== saved) final[saved] = target;
    }
    onConfirm(final);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>Confirm column mapping</DialogTitle>
          <DialogDescription>
            Replay <strong>{automationName}</strong> against your new dataset.
            Review the proposed column mapping and confirm or edit before
            starting.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          {loading || !dryRun ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Analysing column compatibility…
            </div>
          ) : (
            <>
              {dryRun.exactMatches.length > 0 && (
                <div className="mb-4 rounded-md border border-border bg-muted/40 p-3 text-sm">
                  <div className="flex items-center gap-2 mb-1 text-foreground font-medium">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    {dryRun.exactMatches.length} exact match
                    {dryRun.exactMatches.length === 1 ? "" : "es"}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {dryRun.exactMatches.slice(0, 8).join(", ")}
                    {dryRun.exactMatches.length > 8 &&
                      ` (+${dryRun.exactMatches.length - 8} more)`}
                  </div>
                </div>
              )}

              {unresolvedSavedNames.length > 0 && (
                <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
                  <div className="flex items-center gap-2 text-destructive font-medium">
                    <AlertTriangle className="h-4 w-4" />
                    {unresolvedSavedNames.length} unresolved column
                    {unresolvedSavedNames.length === 1 ? "" : "s"}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    Type a new-dataset column name into each unresolved row
                    below, or cancel the run.
                  </div>
                </div>
              )}

              {dryRun.proposedMappings.length > 0 && (
                <ScrollArea className="max-h-[40vh] pr-3">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="text-left py-2 pr-3">Saved column</th>
                        <th className="text-left py-2 pr-3">→ New column</th>
                        <th className="text-left py-2 pr-3">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dryRun.proposedMappings.map((p) => {
                        const value = edits[p.saved] ?? "";
                        const isInvalid =
                          value.length > 0 && !validNewNames.has(value);
                        const isUnmatched = dryRun.unmatchable.includes(
                          p.saved
                        );
                        return (
                          <tr
                            key={p.saved}
                            className="border-b border-border/60"
                          >
                            <td className="py-2 pr-3 font-mono text-xs align-top">
                              {p.saved}
                            </td>
                            <td className="py-2 pr-3 align-top">
                              <Input
                                value={value}
                                onChange={(e) =>
                                  updateEdit(p.saved, e.target.value)
                                }
                                placeholder={
                                  isUnmatched
                                    ? "type a new-dataset column…"
                                    : "(identity)"
                                }
                                list={`auto-cols-${p.saved}`}
                                className={
                                  isInvalid
                                    ? "border-destructive font-mono text-xs"
                                    : "font-mono text-xs"
                                }
                              />
                              <datalist id={`auto-cols-${p.saved}`}>
                                {newDatasetColumns.map((c) => (
                                  <option key={c} value={c} />
                                ))}
                              </datalist>
                              {p.reason && (
                                <div className="mt-1 text-[11px] text-muted-foreground italic">
                                  {p.reason}
                                </div>
                              )}
                            </td>
                            <td className="py-2 pr-3 align-top">
                              <Badge
                                variant={confidenceBadgeVariant(p.confidence)}
                                className="text-[10px]"
                              >
                                {p.confidence}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            Run Automation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
