/**
 * Wave W61-hierarchy-edit · controlled `<Dialog>` sibling component for
 * editing a `SemanticHierarchy.levels` array. Mirrors the W61-add-client
 * `AddEntryForm` shape — modal owns draft state (the editable levels
 * array), parent owns the mutation. The submitted payload is just the
 * `nextLevels: string[]` — the parent host constructs a new
 * `SemanticModel` with that hierarchy's levels swapped and routes
 * through the existing W61-save `patchSemanticModel` endpoint (no
 * dedicated hierarchy endpoint per the brief; per-hierarchy edits are
 * cheap enough to reuse the wholesale-replace path).
 *
 * Why a `<Dialog>` not `<AlertDialog>`: AlertDialog is confirmation-only
 * (single warning paragraph + Cancel / Confirm pair); Dialog is the
 * canonical Radix form-modal for multi-input editing. Hierarchies have
 * 2–8 editable level rows, so Dialog is the right semantic primitive.
 * Matches the W61-add-client precedent on this same distinction.
 *
 * Why the modal owns the draft (not the parent): draft state is
 * mount-scoped — it lives only for the duration of the edit and is
 * discarded on close. Parent ownership would force a `clearDraft` step
 * on every close + a stale-draft concern if the admin closes and
 * re-opens for a different hierarchy quickly. An effect resets the
 * draft when `hierarchy` (the open signal) changes so the per-row
 * inputs are always seeded from the current model state on open.
 *
 * Why the parent still owns the mutation: success updates parent
 * `data` (the model). The modal can't update parent state on its own;
 * it would have to call back to a parent callback anyway. Parent-owned
 * mutation + signalling close via `onOpenChange(false)` is the same
 * shape as `DeleteEntryConfirmation` + `AddEntryForm`.
 *
 * Why no per-row "edit in place" pattern (vs. inline-edit cell): the
 * inline-edit pattern (W61-edit-text) covers ONE field per cell with
 * an EditableCell that has its own optimistic-edit + commit semantics.
 * Hierarchy editing needs MULTIPLE rows + reorder semantics, which
 * doesn't fit the per-cell shape. The modal is the right primitive for
 * this density.
 */
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
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
import type { SemanticHierarchy } from "@/shared/schema";
import {
  appendLevel,
  buildHierarchyEditHeadline,
  buildHierarchyEditSubmitLabel,
  MAX_LEVELS,
  MIN_LEVELS,
  moveLevelDown,
  moveLevelUp,
  removeLevel,
  setLevelAt,
  validateLevels,
} from "../lib/semanticModelHierarchyLevels";

export interface HierarchyEditorProps {
  /**
   * Non-null = open. The full SemanticHierarchy whose levels are
   * being edited; the modal seeds its draft from `hierarchy.levels`
   * on every open transition. `null` closes the modal.
   */
  hierarchy: SemanticHierarchy | null;
  /**
   * Pre-existing in-flight guard. When true, all buttons are
   * disabled, the submit button shows the U+2026 ellipsis label, and
   * the close handler is expected to be swallowed by the parent so
   * the modal stays open until the mutation resolves.
   */
  submitting: boolean;
  /**
   * Generic error from the PATCH path. Renders as a destructive
   * banner inside the modal body (separate from per-level validation
   * errors).
   */
  submitError: string | null;
  /**
   * Called when the admin clicks Cancel, presses Esc, or clicks the
   * overlay. Parent should set `hierarchy` back to `null`. While
   * `submitting` is true the parent should swallow the close.
   */
  onOpenChange: (next: boolean) => void;
  /**
   * Called when the admin submits a validated levels array. The
   * parent fires `patchSemanticModel` with the updated model. The
   * modal stays open with `submitting=true` until the parent calls
   * `onOpenChange(false)`.
   *
   * Receives the hierarchy's `name` (so the parent can locate the
   * right entry in the model) and the new ordered `levels` array.
   * The parent uses the existing `data.model.hierarchies.map` shape
   * to swap in the new levels.
   */
  onConfirm: (hierarchyName: string, nextLevels: string[]) => void;
}

export function HierarchyEditor({
  hierarchy,
  submitting,
  submitError,
  onOpenChange,
  onConfirm,
}: HierarchyEditorProps) {
  const open = hierarchy !== null;
  // Draft is seeded on every open transition. The cost of re-seeding
  // is trivial; the semantics is "open the modal → start from the
  // model's current state".
  const [draftLevels, setDraftLevels] = useState<string[]>([]);
  // True once the admin has tried to submit at least once — gates
  // surface of per-level errors so the modal doesn't yell at the
  // admin while they're still typing.
  const [validationActive, setValidationActive] = useState(false);

  useEffect(() => {
    if (hierarchy) {
      setDraftLevels([...hierarchy.levels]);
      setValidationActive(false);
    }
  }, [hierarchy]);

  const validation = validateLevels(draftLevels);
  const canAdd = draftLevels.length < MAX_LEVELS && !submitting;
  const canRemove = draftLevels.length > MIN_LEVELS && !submitting;

  function handleSubmit() {
    if (!hierarchy) return;
    setValidationActive(true);
    if (!validation.valid) return;
    onConfirm(hierarchy.name, draftLevels);
  }

  function handleMoveUp(idx: number) {
    setDraftLevels((prev) => moveLevelUp(prev, idx));
  }

  function handleMoveDown(idx: number) {
    setDraftLevels((prev) => moveLevelDown(prev, idx));
  }

  function handleRemove(idx: number) {
    setDraftLevels((prev) => removeLevel(prev, idx));
  }

  function handleAppend() {
    setDraftLevels((prev) => appendLevel(prev, ""));
  }

  function handleSetAt(idx: number, value: string) {
    setDraftLevels((prev) => setLevelAt(prev, idx, value));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        data-testid="admin-semantic-model-hierarchy-edit-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {hierarchy
              ? buildHierarchyEditHeadline(hierarchy.label)
              : "Edit levels"}
          </DialogTitle>
          <DialogDescription>
            Reorder, rename, add, or remove the levels that make up this
            hierarchy. Each level references a SemanticDimension by name.
            Hierarchies must have between {MIN_LEVELS} and {MAX_LEVELS}{" "}
            levels.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          {draftLevels.map((level, idx) => {
            const error = validationActive ? validation.perLevel[idx] : null;
            return (
              <div
                key={idx}
                className="flex items-start gap-2"
                data-testid={`admin-semantic-model-hierarchy-edit-row-${idx}`}
              >
                <div className="flex flex-col gap-1 flex-1">
                  <Input
                    value={level}
                    onChange={(e) => handleSetAt(idx, e.target.value)}
                    disabled={submitting}
                    placeholder="snake_case dimension name"
                    aria-label={`Level ${idx + 1}`}
                    data-testid={`admin-semantic-model-hierarchy-edit-level-${idx}`}
                    className={error ? "border-destructive" : ""}
                  />
                  {error ? (
                    <p
                      className="text-xs text-destructive"
                      data-testid={`admin-semantic-model-hierarchy-edit-level-error-${idx}`}
                    >
                      {error}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  disabled={idx === 0 || submitting}
                  onClick={() => handleMoveUp(idx)}
                  aria-label={`Move level ${idx + 1} up`}
                  data-testid={`admin-semantic-model-hierarchy-edit-move-up-${idx}`}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2"
                  disabled={idx === draftLevels.length - 1 || submitting}
                  onClick={() => handleMoveDown(idx)}
                  aria-label={`Move level ${idx + 1} down`}
                  data-testid={`admin-semantic-model-hierarchy-edit-move-down-${idx}`}
                >
                  <ArrowDown className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={!canRemove}
                  onClick={() => handleRemove(idx)}
                  aria-label={`Remove level ${idx + 1}`}
                  data-testid={`admin-semantic-model-hierarchy-edit-remove-${idx}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={!canAdd}
            onClick={handleAppend}
            data-testid="admin-semantic-model-hierarchy-edit-add"
          >
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add level
          </Button>
          {validationActive && validation.global ? (
            <p
              className="text-xs text-destructive"
              data-testid="admin-semantic-model-hierarchy-edit-global-error"
            >
              {validation.global}
            </p>
          ) : null}
          {submitError ? (
            <p
              className="text-xs text-destructive"
              data-testid="admin-semantic-model-hierarchy-edit-submit-error"
              role="alert"
            >
              {submitError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            data-testid="admin-semantic-model-hierarchy-edit-cancel"
          >
            Cancel
          </Button>
          <Button
            disabled={submitting}
            onClick={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
            data-testid="admin-semantic-model-hierarchy-edit-submit"
          >
            {buildHierarchyEditSubmitLabel(submitting)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
