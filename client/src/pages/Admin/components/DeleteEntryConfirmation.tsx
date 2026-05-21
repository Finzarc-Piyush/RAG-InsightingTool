/**
 * W61-delete-client · Per-entry delete confirmation `<AlertDialog>`
 * sibling component to `AuditHistoryCard`. Controlled by the host
 * page's `pendingDelete` state.
 *
 * Why a controlled `<AlertDialog>` rather than `window.confirm`: the
 * downstream-references count is async (round-trip to
 * `/admin/semantic-models/:sessionId/references`) and the modal needs
 * to render a loading state while the fetch is in flight.
 * `window.confirm` is synchronous and can't show intermediate states;
 * the audit-revert path uses it because its only context is the entry
 * already in hand, but the delete path is references-count-first.
 *
 * Why the modal owns the references fetch (not the parent): references
 * state is mount-scoped — it lives for the duration of the modal and
 * is GC'd on close. Keeping the fetch / loading / error state inside
 * this component lets the unmount handle cleanup automatically. The
 * parent would otherwise need a `clearReferences` step on every modal
 * close + a stale-fetch guard when the admin re-opens for a different
 * entry quickly.
 *
 * Why the parent still owns the delete mutation: success updates the
 * parent's `data` (the model). The modal can't update parent state on
 * its own; it would have to call back to a parent callback anyway.
 * Putting the mutation in the parent + signalling close via
 * `onOpenChange(false)` is the simpler shape. The parent's `deleting`
 * flag disables the modal buttons while the DELETE is in flight.
 *
 * Why we don't pre-fetch references on hover / mount: the modal is the
 * only place that needs them and it opens on an explicit Delete click.
 * Pre-fetching on hover would burn round-trips on cursor-only-passes;
 * pre-fetching on detail-page mount would walk N references-scans per
 * page load. The modal-on-open fetch is right-sized.
 *
 * Why we render the audit-log reassurance copy even when the
 * references fetch failed: the audit log is still load-bearing — the
 * admin can recover from the delete via revert regardless of whether
 * the references check succeeded. Suppressing the reassurance on the
 * error branch would leave the admin to wonder if the failed
 * pre-check also implies a broken audit-log path.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchSemanticModelReferences,
  type AdminSemanticModelEntryKind,
  type AdminSemanticModelReferencesResponse,
} from "@/lib/api/admin";
import {
  buildDeleteGenericConfirmation,
  buildDeleteHeadline,
  buildDeleteReferencesWarning,
  DELETE_AUDIT_LOG_REASSURANCE,
} from "../lib/semanticModelDeleteConfirmation";

export interface DeleteEntryConfirmationProps {
  /**
   * `null` when the modal is closed; `{ kind, name }` when an admin
   * clicked Delete on a row. The component derives `open` from this:
   * a non-null value opens the dialog and triggers the references
   * fetch effect.
   */
  pending: { kind: AdminSemanticModelEntryKind; name: string } | null;
  /**
   * Session id for the references fetch URL. Stable across renders
   * (the parent reads it from the route).
   */
  sessionId: string;
  /**
   * `true` while the parent's `deleteSemanticModelEntry` mutation is
   * in flight. Disables both modal buttons; the destructive button
   * also swaps label to `"Deleting…"`.
   */
  deleting: boolean;
  /**
   * Parent's delete-mutation error, surfaces inline below the
   * confirmation body. Cleared by the parent on next open.
   */
  deleteError: string | null;
  /**
   * Called when the admin clicks Cancel or otherwise dismisses the
   * dialog (Esc, overlay click). Parent should set `pendingDelete`
   * back to `null` when `next === false`. While `deleting` is true,
   * Radix already blocks the dismiss affordances, so this only fires
   * on legitimate cancellations.
   */
  onOpenChange: (next: boolean) => void;
  /**
   * Called when the admin clicks the destructive Delete button. The
   * parent fires the DELETE mutation; the modal stays open with
   * `deleting=true` until the parent closes it via `onOpenChange(false)`.
   */
  onConfirm: () => void;
}

export function DeleteEntryConfirmation({
  pending,
  sessionId,
  deleting,
  deleteError,
  onOpenChange,
  onConfirm,
}: DeleteEntryConfirmationProps) {
  // Mount-scoped references-fetch state. `useEffect` below fires the
  // fetch when `pending` transitions from null to non-null (or
  // between two non-null entries — admin closes + reopens on a
  // different row before the first round-trip resolves).
  const [references, setReferences] =
    useState<AdminSemanticModelReferencesResponse | null>(null);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referencesError, setReferencesError] = useState<string | null>(null);

  const pendingKind = pending?.kind;
  const pendingName = pending?.name;

  useEffect(() => {
    if (!pendingKind || !pendingName) {
      // Modal closed — drop the prior fetch result so the next open
      // starts clean. The next open re-fires the effect because the
      // deps will transition non-null again.
      setReferences(null);
      setReferencesError(null);
      setReferencesLoading(false);
      return;
    }
    let cancelled = false;
    setReferences(null);
    setReferencesError(null);
    setReferencesLoading(true);
    fetchSemanticModelReferences(sessionId, pendingName)
      .then((res) => {
        if (cancelled) return;
        // Stale-fetch guard: if the user re-opens for a different
        // entry while the first round-trip is still in flight, the
        // first resolver would otherwise stomp the second's state.
        // The dep change re-fires the effect (which sets `cancelled`
        // on the prior closure) so this guard is also covered by
        // React's effect cleanup; the explicit `res.entry !==
        // pendingName` check is a belt-and-braces second line.
        if (res.entry !== pendingName) return;
        setReferences(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setReferencesError(
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        if (!cancelled) setReferencesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, pendingKind, pendingName]);

  // Radix `<AlertDialog>` blocks dismiss while we want — render only
  // when `pending` exists. Closing the modal sends `open=false` up
  // the parent; the parent nulls `pending` which unmounts on the
  // next render. The `open` prop is the derived boolean.
  const open = pending !== null;
  const kind = pendingKind ?? "metric"; // sane default during close transition
  const name = pendingName ?? "";

  const warning =
    references && !referencesLoading && !referencesError
      ? buildDeleteReferencesWarning(
          kind,
          references.chartCount,
          references.totalOccurrences,
          references.dashboardCount,
          references.dashboardTileCount,
        )
      : null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="admin-semantic-model-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{buildDeleteHeadline(kind, name)}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {referencesLoading ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="admin-semantic-model-delete-references-loading"
                >
                  Checking for downstream chart references…
                </p>
              ) : referencesError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="admin-semantic-model-delete-references-error"
                >
                  Could not check for downstream references:{" "}
                  {referencesError}. Proceeding will skip the
                  references precheck.
                </p>
              ) : warning ? (
                <div
                  className="space-y-1"
                  data-testid="admin-semantic-model-delete-references-count"
                >
                  <p className="text-sm font-medium text-destructive">
                    {warning.headline}
                  </p>
                  {warning.subhead ? (
                    <p className="text-xs text-muted-foreground">
                      {warning.subhead}
                    </p>
                  ) : null}
                </div>
              ) : (
                <p
                  className="text-sm text-foreground"
                  data-testid="admin-semantic-model-delete-references-count"
                >
                  {buildDeleteGenericConfirmation(kind, name)}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {DELETE_AUDIT_LOG_REASSURANCE}
              </p>
              {deleteError ? (
                <p
                  className="text-sm text-destructive"
                  data-testid="admin-semantic-model-delete-error"
                >
                  Delete failed: {deleteError}. The model is
                  unchanged; try again or close this dialog.
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={deleting}
            data-testid="admin-semantic-model-delete-cancel"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            disabled={deleting || referencesLoading}
            onClick={(e) => {
              // Prevent Radix's default close-on-action behaviour —
              // we want the modal to stay open until the parent
              // mutation resolves (success → parent closes; error →
              // parent shows the error inline and lets the admin
              // retry or close manually).
              e.preventDefault();
              onConfirm();
            }}
            data-testid="admin-semantic-model-delete-confirm"
          >
            <Trash2 className="h-4 w-4 mr-2" aria-hidden="true" />
            {deleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
