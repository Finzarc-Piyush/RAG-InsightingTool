/**
 * W61-audit-history-tab / W61-detail-extract · collapsible "Audit history"
 * Card for the admin semantic-model detail page. Renders the prior-model
 * ring buffer (newest-first, cap-at-10). Closed by default so the Cosmos
 * round-trip is opt-in; opens on click and refreshes whenever the parent
 * doc's `lastUpdatedAt` bumps (save / revert) — that effect is owned by
 * the parent, this component just renders given the resulting log state.
 *
 * Extracted from `AdminSemanticModelDetail.tsx` in W61-detail-extract to
 * relieve file-size pressure on the host before W61-add-delete grows it
 * further. State lives in the parent (`historyOpen`, `historyLog`,
 * `reverting`, etc.) so the per-row "Revert" buttons can share the same
 * disabled-gate semantics as the rest of the page (a save in flight
 * blocks reverts and vice-versa).
 *
 * Five mutually exclusive render branches inside `CollapsibleContent`:
 * revert-error banner / loading / error / empty / list. The banner above
 * the loading branch is non-exclusive — a prior revert-error can sit
 * above any of the four state branches.
 */
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type {
  AdminSemanticModelAuditEntry,
  AdminSemanticModelAuditLog,
} from "@/lib/api/admin";
import { buildAuditEntrySummary } from "../lib/semanticModelAuditHistory";

export interface AuditHistoryCardProps {
  historyOpen: boolean;
  onOpenChange: (next: boolean) => void;
  historyLog: AdminSemanticModelAuditLog | null;
  historyLoading: boolean;
  historyError: string | null;
  revertError: string | null;
  reverting: number | null;
  saving: boolean;
  onRevert: (
    entry: AdminSemanticModelAuditEntry,
    indexFromNewest: number,
    total: number,
  ) => void;
}

export function AuditHistoryCard({
  historyOpen,
  onOpenChange,
  historyLog,
  historyLoading,
  historyError,
  revertError,
  reverting,
  saving,
  onRevert,
}: AuditHistoryCardProps) {
  return (
    <Card className="p-0 overflow-hidden">
      <Collapsible open={historyOpen} onOpenChange={onOpenChange}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full px-4 py-3 border-b border-border flex items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors"
            data-testid="admin-semantic-model-audit-history-trigger"
          >
            <div className="flex flex-col">
              <h2 className="text-base font-semibold text-foreground">
                Audit history
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Prior model versions (newest first, last 10 saves).
                Revert to restore a snapshot — the current model
                will be appended to this log first.
              </p>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                historyOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {revertError ? (
            <div
              className="mx-4 mt-4 rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
              data-testid="admin-semantic-model-audit-history-revert-error"
            >
              Revert failed: {revertError}. The current model is
              unchanged; try again.
            </div>
          ) : null}
          {historyLoading && !historyLog ? (
            <div
              className="p-4 text-sm text-muted-foreground"
              data-testid="admin-semantic-model-audit-history-loading"
            >
              Loading audit history…
            </div>
          ) : historyError ? (
            <div
              className="p-4 text-sm text-destructive"
              data-testid="admin-semantic-model-audit-history-error"
            >
              Failed to load audit history: {historyError}
            </div>
          ) : historyLog && historyLog.entries.length === 0 ? (
            <div
              className="p-4 text-sm text-muted-foreground"
              data-testid="admin-semantic-model-audit-history-empty"
            >
              No prior versions yet. The audit log captures the
              pre-save snapshot every time an admin edits the
              model; once you make an edit, the snapshot will
              appear here.
            </div>
          ) : historyLog ? (
            <ul
              className="divide-y divide-border"
              data-testid="admin-semantic-model-audit-history-list"
            >
              {historyLog.entries.map((entry, idx) => {
                const total = historyLog.entries.length;
                const summary = buildAuditEntrySummary(entry, idx, total);
                const rowReverting = reverting === idx;
                return (
                  <li
                    key={`${entry.savedAt}-${entry.priorVersion}`}
                    className="p-4 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">
                        {summary.headline}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 tabular-nums">
                        {summary.subhead}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        saving || reverting !== null || historyLoading
                      }
                      onClick={() => onRevert(entry, idx, total)}
                      data-testid={`admin-semantic-model-audit-history-revert-${idx}`}
                    >
                      {rowReverting ? "Reverting…" : "Revert"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
