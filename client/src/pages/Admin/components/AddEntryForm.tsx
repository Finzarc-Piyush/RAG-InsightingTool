/**
 * W61-add-client · Per-kind Add-entry `<Dialog>` sibling component to
 * `AuditHistoryCard` and `DeleteEntryConfirmation`. Controlled by the
 * host page's `addOpen: AdminSemanticModelEntryKind | null` state.
 *
 * Why a controlled `<Dialog>` (not `<AlertDialog>`): AlertDialog is
 * confirmation-only ("Cancel" + "Confirm" pair); Dialog is the
 * canonical Radix form-modal which supports multiple inputs and a
 * primary submit button. The W61-delete-client used AlertDialog because
 * its body was a single warning paragraph; this wave's body has 4-7
 * inputs depending on the kind.
 *
 * Why the modal owns the draft (not the parent): draft state is
 * mount-scoped — it lives for the duration of the modal and is GC'd on
 * close. Putting it in the parent would force a `clearDraft` step on
 * every close + a stale-draft concern when the admin opens for one kind
 * then re-opens for another quickly. An effect resets the draft when
 * `open` (the kind discriminant) changes so the per-kind defaults are
 * always fresh on open.
 *
 * Why the parent still owns the mutation: success updates parent
 * `data` (the model). The modal can't update parent state on its own;
 * it would have to call back to a parent callback anyway. Parent-owned
 * mutation + signalling close via `onOpenChange(false)` is the same
 * shape as `DeleteEntryConfirmation`.
 *
 * Why `e.preventDefault()` on the submit `<button>`: Radix Dialog has
 * no default close-on-submit behaviour (unlike `<AlertDialogAction>`)
 * but we use the same pattern as the delete modal so the parent's
 * `submitError` / `nameCollision` state can surface inline while the
 * modal stays open. The default `type="submit"` form behaviour is
 * suppressed via the local handler.
 */
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminSemanticModelEntryKind } from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
} from "@/shared/schema";
import {
  validateCurrencyCode,
  validateDescription,
  validateExpression,
  validateLabel,
  validateName,
} from "../lib/semanticModelEditValidation";
import {
  buildAddHeadline,
  buildAddSubmitLabel,
  formatNameCollisionError,
  parseHierarchyLevels,
} from "../lib/semanticModelAddForm";

// Per-kind option lists — inlined to avoid coupling to the host's
// internal `METRIC_FORMAT_OPTIONS` / `DIMENSION_KIND_OPTIONS` constants
// (the host doesn't export them, and exporting them just to share with
// this sibling would invite a circular import). The lists are short
// enough that local duplication is cheaper than the coupling.
const METRIC_FORMAT_OPTIONS = [
  { value: "number", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "currency", label: "Currency" },
  { value: "ratio", label: "Ratio" },
  { value: "duration", label: "Duration" },
] as const satisfies ReadonlyArray<{
  value: SemanticMetric["format"];
  label: string;
}>;

const DIMENSION_KIND_OPTIONS = [
  { value: "categorical", label: "Categorical" },
  { value: "temporal", label: "Temporal" },
  { value: "numeric_binned", label: "Numeric (binned)" },
  { value: "geo", label: "Geo" },
] as const satisfies ReadonlyArray<{
  value: SemanticDimension["kind"];
  label: string;
}>;

const TEMPORAL_GRAIN_AUTO = "__auto__" as const;
const TEMPORAL_GRAIN_OPTIONS = [
  { value: TEMPORAL_GRAIN_AUTO, label: "Auto (let agent derive)" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
] as const;

// Per-kind draft state. A discriminated union mirrors the per-kind
// field set. The form initializes draft to per-kind defaults on every
// `open` transition via the effect below.
interface MetricDraft {
  name: string;
  label: string;
  description: string;
  expression: string;
  format: SemanticMetric["format"];
  currencyCode: string;
  exposed: boolean;
}
interface DimensionDraft {
  name: string;
  label: string;
  description: string;
  column: string;
  kind: SemanticDimension["kind"];
  temporalGrain: typeof TEMPORAL_GRAIN_AUTO | "day" | "week" | "month" | "quarter" | "year";
  exposed: boolean;
}
interface HierarchyDraft {
  name: string;
  label: string;
  description: string;
  levels: string;
}

function emptyMetricDraft(): MetricDraft {
  return {
    name: "",
    label: "",
    description: "",
    expression: "",
    format: "number",
    currencyCode: "",
    exposed: true,
  };
}
function emptyDimensionDraft(): DimensionDraft {
  return {
    name: "",
    label: "",
    description: "",
    column: "",
    kind: "categorical",
    temporalGrain: TEMPORAL_GRAIN_AUTO,
    exposed: true,
  };
}
function emptyHierarchyDraft(): HierarchyDraft {
  return {
    name: "",
    label: "",
    description: "",
    levels: "",
  };
}

export interface AddEntryFormProps {
  /**
   * `null` when the modal is closed; the kind enum value when an admin
   * clicked the matching `+ Add` button. The component derives `open`
   * from this — non-null opens the dialog and triggers the per-kind
   * draft reset effect.
   */
  open: AdminSemanticModelEntryKind | null;
  /**
   * `true` while the parent's `addSemanticModelEntry` mutation is in
   * flight. Disables both modal buttons; the submit button also swaps
   * label to e.g. `"Adding metric…"`.
   */
  submitting: boolean;
  /**
   * Parent's mutation error for the generic non-409 failure case —
   * surfaces below the form body. Cleared by the parent on next open.
   */
  submitError: string | null;
  /**
   * Parent's typed 409 collision result — surfaces inline under the
   * name field. Cleared by the parent on next open or successful
   * submit.
   */
  nameCollision: { kind: AdminSemanticModelEntryKind; name: string } | null;
  /**
   * Called when the admin clicks Cancel, presses Esc, or clicks the
   * overlay. Parent should set `addOpen` back to `null`. While
   * `submitting` is true the parent should swallow the close (matches
   * the W61-delete-client convention).
   */
  onOpenChange: (next: boolean) => void;
  /**
   * Called when the admin submits a validated entry. The parent fires
   * the POST mutation. The modal stays open with `submitting=true`
   * until the parent closes it via `onOpenChange(false)`.
   *
   * The entry's discriminant matches the modal's `open` kind. The
   * union type lets the host's `handleAdd` switch on `kind` and pass
   * the typed entry to `addSemanticModelEntry`.
   */
  onConfirm: (
    kind: AdminSemanticModelEntryKind,
    entry: SemanticMetric | SemanticDimension | SemanticHierarchy,
  ) => void;
}

export function AddEntryForm({
  open,
  submitting,
  submitError,
  nameCollision,
  onOpenChange,
  onConfirm,
}: AddEntryFormProps) {
  // Per-kind draft. Reset to per-kind defaults whenever `open` changes
  // (including null → kind, kind → null, kind → other kind).
  const [metricDraft, setMetricDraft] = useState<MetricDraft>(emptyMetricDraft);
  const [dimensionDraft, setDimensionDraft] = useState<DimensionDraft>(
    emptyDimensionDraft,
  );
  const [hierarchyDraft, setHierarchyDraft] = useState<HierarchyDraft>(
    emptyHierarchyDraft,
  );
  // Per-field local validation error, surfaces under the input.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>(
    {},
  );

  useEffect(() => {
    // Reset every draft + clear field errors on every open transition.
    // The cost of resetting all three (vs. only the matching kind) is
    // trivial; the simpler semantics is "open the modal → empty form".
    setMetricDraft(emptyMetricDraft());
    setDimensionDraft(emptyDimensionDraft());
    setHierarchyDraft(emptyHierarchyDraft());
    setFieldErrors({});
  }, [open]);

  // Helper that runs a validator on a field, stores the error, returns true on valid.
  function validateField(field: string, error: string | null): boolean {
    setFieldErrors((prev) => ({ ...prev, [field]: error }));
    return error === null;
  }

  function handleSubmit() {
    if (!open) return;
    // Per-kind validation + assemble entry.
    if (open === "metric") {
      const nameErr = validateName(metricDraft.name);
      const labelErr = validateLabel(metricDraft.label);
      const descErr = validateDescription(metricDraft.description);
      const exprErr = validateExpression(metricDraft.expression);
      const currencyErr =
        metricDraft.format === "currency"
          ? validateCurrencyCode(metricDraft.currencyCode) ??
            (metricDraft.currencyCode.trim() === ""
              ? "Required when format is currency"
              : null)
          : null;
      // Run every validator so each error surfaces inline (don't
      // short-circuit on the first failure — the admin should see all
      // issues at once). Then combine via logical AND for the gate.
      const results = [
        validateField("name", nameErr),
        validateField("label", labelErr),
        validateField("description", descErr),
        validateField("expression", exprErr),
        validateField("currencyCode", currencyErr),
      ];
      if (!results.every(Boolean)) return;
      const entry: SemanticMetric = {
        name: metricDraft.name.trim(),
        label: metricDraft.label.trim(),
        expression: metricDraft.expression.trim(),
        references: [],
        format: metricDraft.format,
        ...(metricDraft.format === "currency" && metricDraft.currencyCode.trim()
          ? { currencyCode: metricDraft.currencyCode.trim().toUpperCase() }
          : {}),
        ...(metricDraft.description.trim()
          ? { description: metricDraft.description.trim() }
          : {}),
        exposed: metricDraft.exposed,
        source: "user",
      };
      onConfirm("metric", entry);
      return;
    }
    if (open === "dimension") {
      const nameErr = validateName(dimensionDraft.name);
      const labelErr = validateLabel(dimensionDraft.label);
      const descErr = validateDescription(dimensionDraft.description);
      const columnErr =
        dimensionDraft.column.trim() === "" ? "Column is required" : null;
      const results = [
        validateField("name", nameErr),
        validateField("label", labelErr),
        validateField("description", descErr),
        validateField("column", columnErr),
      ];
      if (!results.every(Boolean)) return;
      const entry: SemanticDimension = {
        name: dimensionDraft.name.trim(),
        label: dimensionDraft.label.trim(),
        column: dimensionDraft.column.trim(),
        kind: dimensionDraft.kind,
        ...(dimensionDraft.kind === "temporal" &&
        dimensionDraft.temporalGrain !== TEMPORAL_GRAIN_AUTO
          ? { temporalGrain: dimensionDraft.temporalGrain }
          : {}),
        ...(dimensionDraft.description.trim()
          ? { description: dimensionDraft.description.trim() }
          : {}),
        exposed: dimensionDraft.exposed,
        source: "user",
      };
      onConfirm("dimension", entry);
      return;
    }
    // hierarchy
    const nameErr = validateName(hierarchyDraft.name);
    const labelErr = validateLabel(hierarchyDraft.label);
    const descErr = validateDescription(hierarchyDraft.description);
    const parsedLevels = parseHierarchyLevels(hierarchyDraft.levels);
    const levelsErr =
      parsedLevels.length < 2
        ? "At least 2 levels required (one per line)"
        : parsedLevels.length > 8
          ? "At most 8 levels"
          : parsedLevels.find((l) => validateName(l) !== null)
            ? "Each level must be snake_case (matches a dimension name)"
            : null;
    const results = [
      validateField("name", nameErr),
      validateField("label", labelErr),
      validateField("description", descErr),
      validateField("levels", levelsErr),
    ];
    if (!results.every(Boolean)) return;
    const entry: SemanticHierarchy = {
      name: hierarchyDraft.name.trim(),
      label: hierarchyDraft.label.trim(),
      levels: parsedLevels,
      ...(hierarchyDraft.description.trim()
        ? { description: hierarchyDraft.description.trim() }
        : {}),
      source: "user",
    };
    onConfirm("hierarchy", entry);
  }

  const dialogOpen = open !== null;
  const kind: AdminSemanticModelEntryKind = open ?? "metric";

  // Render the per-kind body. Falls through the three branches; each
  // body renders the inputs for that kind. The collision message (if
  // any) surfaces under the name field; the generic submit error
  // surfaces at the bottom of the form body.
  return (
    <Dialog open={dialogOpen} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        data-testid="admin-semantic-model-add-dialog"
      >
        <DialogHeader>
          <DialogTitle>{buildAddHeadline(kind)}</DialogTitle>
          <DialogDescription>
            Fill in the fields below. The new entry will be saved to the
            session&apos;s semantic model and the audit log will record
            this addition so it can be undone via revert.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          {open === "metric" ? (
            <MetricFields
              draft={metricDraft}
              setDraft={setMetricDraft}
              fieldErrors={fieldErrors}
              nameCollision={
                nameCollision?.kind === "metric" ? nameCollision.name : null
              }
            />
          ) : open === "dimension" ? (
            <DimensionFields
              draft={dimensionDraft}
              setDraft={setDimensionDraft}
              fieldErrors={fieldErrors}
              nameCollision={
                nameCollision?.kind === "dimension" ? nameCollision.name : null
              }
            />
          ) : open === "hierarchy" ? (
            <HierarchyFields
              draft={hierarchyDraft}
              setDraft={setHierarchyDraft}
              fieldErrors={fieldErrors}
              nameCollision={
                nameCollision?.kind === "hierarchy" ? nameCollision.name : null
              }
            />
          ) : null}
          {submitError ? (
            <p
              className="text-sm text-destructive"
              data-testid="admin-semantic-model-add-submit-error"
            >
              Add failed: {submitError}. The model is unchanged; try again
              or close this dialog.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              data-testid="admin-semantic-model-add-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              data-testid="admin-semantic-model-add-submit"
            >
              <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
              {buildAddSubmitLabel(kind, submitting)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Per-kind field-set sub-components ───────────────────────────────

interface CommonFieldsProps<T> {
  draft: T;
  setDraft: (next: T) => void;
  fieldErrors: Record<string, string | null>;
  nameCollision: string | null;
}

function FieldError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return <p className="text-xs text-destructive mt-1">{message}</p>;
}

function NameField({
  value,
  onChange,
  fieldErrors,
  nameCollision,
  kind,
}: {
  value: string;
  onChange: (next: string) => void;
  fieldErrors: Record<string, string | null>;
  nameCollision: string | null;
  kind: AdminSemanticModelEntryKind;
}) {
  // Collision error takes priority over the local validation error —
  // the collision is the more actionable signal (admin needs to rename
  // before re-submitting). The local validation error returns once the
  // admin changes the name (since `nameCollision` is cleared on the
  // next open).
  const collisionMessage = nameCollision
    ? formatNameCollisionError(kind, nameCollision)
    : null;
  const validationError = fieldErrors.name ?? null;
  const displayError = collisionMessage ?? validationError;
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        Name
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="snake_case_identifier"
        className="font-mono text-sm"
        data-testid="admin-semantic-model-add-name"
        autoFocus
      />
      <FieldError message={displayError} />
    </div>
  );
}

function LabelField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error: string | null | undefined;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        Label
      </label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Human-readable label"
        data-testid="admin-semantic-model-add-label"
      />
      <FieldError message={error} />
    </div>
  );
}

function DescriptionField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (next: string) => void;
  error: string | null | undefined;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">
        Description (optional)
      </label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="One or two sentences for the planner prompt"
        data-testid="admin-semantic-model-add-description"
      />
      <FieldError message={error} />
    </div>
  );
}

function MetricFields({
  draft,
  setDraft,
  fieldErrors,
  nameCollision,
}: CommonFieldsProps<MetricDraft>) {
  return (
    <>
      <NameField
        value={draft.name}
        onChange={(next) => setDraft({ ...draft, name: next })}
        fieldErrors={fieldErrors}
        nameCollision={nameCollision}
        kind="metric"
      />
      <LabelField
        value={draft.label}
        onChange={(next) => setDraft({ ...draft, label: next })}
        error={fieldErrors.label}
      />
      <DescriptionField
        value={draft.description}
        onChange={(next) => setDraft({ ...draft, description: next })}
        error={fieldErrors.description}
      />
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Expression
        </label>
        <Textarea
          value={draft.expression}
          onChange={(e) => setDraft({ ...draft, expression: e.target.value })}
          rows={3}
          className="font-mono text-sm"
          placeholder="SUM(value_sales)"
          data-testid="admin-semantic-model-add-expression"
        />
        <FieldError message={fieldErrors.expression} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Format
          </label>
          <Select
            value={draft.format}
            onValueChange={(next) =>
              setDraft({ ...draft, format: next as SemanticMetric["format"] })
            }
          >
            <SelectTrigger data-testid="admin-semantic-model-add-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRIC_FORMAT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {draft.format === "currency" ? (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Currency code
            </label>
            <Input
              value={draft.currencyCode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  currencyCode: e.target.value.toUpperCase(),
                })
              }
              placeholder="INR"
              maxLength={3}
              className="uppercase"
              data-testid="admin-semantic-model-add-currency"
            />
            <FieldError message={fieldErrors.currencyCode} />
          </div>
        ) : null}
      </div>
      <ExposedField
        exposed={draft.exposed}
        onChange={(next) => setDraft({ ...draft, exposed: next })}
      />
    </>
  );
}

function DimensionFields({
  draft,
  setDraft,
  fieldErrors,
  nameCollision,
}: CommonFieldsProps<DimensionDraft>) {
  return (
    <>
      <NameField
        value={draft.name}
        onChange={(next) => setDraft({ ...draft, name: next })}
        fieldErrors={fieldErrors}
        nameCollision={nameCollision}
        kind="dimension"
      />
      <LabelField
        value={draft.label}
        onChange={(next) => setDraft({ ...draft, label: next })}
        error={fieldErrors.label}
      />
      <DescriptionField
        value={draft.description}
        onChange={(next) => setDraft({ ...draft, description: next })}
        error={fieldErrors.description}
      />
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Column
        </label>
        <Input
          value={draft.column}
          onChange={(e) => setDraft({ ...draft, column: e.target.value })}
          placeholder="dataset column name"
          className="font-mono text-sm"
          data-testid="admin-semantic-model-add-column"
        />
        <FieldError message={fieldErrors.column} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">
            Kind
          </label>
          <Select
            value={draft.kind}
            onValueChange={(next) =>
              setDraft({
                ...draft,
                kind: next as SemanticDimension["kind"],
                temporalGrain:
                  next === "temporal" ? draft.temporalGrain : TEMPORAL_GRAIN_AUTO,
              })
            }
          >
            <SelectTrigger data-testid="admin-semantic-model-add-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIMENSION_KIND_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {draft.kind === "temporal" ? (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">
              Temporal grain
            </label>
            <Select
              value={draft.temporalGrain}
              onValueChange={(next) =>
                setDraft({
                  ...draft,
                  temporalGrain: next as DimensionDraft["temporalGrain"],
                })
              }
            >
              <SelectTrigger data-testid="admin-semantic-model-add-grain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPORAL_GRAIN_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <ExposedField
        exposed={draft.exposed}
        onChange={(next) => setDraft({ ...draft, exposed: next })}
      />
    </>
  );
}

function HierarchyFields({
  draft,
  setDraft,
  fieldErrors,
  nameCollision,
}: CommonFieldsProps<HierarchyDraft>) {
  return (
    <>
      <NameField
        value={draft.name}
        onChange={(next) => setDraft({ ...draft, name: next })}
        fieldErrors={fieldErrors}
        nameCollision={nameCollision}
        kind="hierarchy"
      />
      <LabelField
        value={draft.label}
        onChange={(next) => setDraft({ ...draft, label: next })}
        error={fieldErrors.label}
      />
      <DescriptionField
        value={draft.description}
        onChange={(next) => setDraft({ ...draft, description: next })}
        error={fieldErrors.description}
      />
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1">
          Levels (one dimension name per line, top → bottom)
        </label>
        <Textarea
          value={draft.levels}
          onChange={(e) => setDraft({ ...draft, levels: e.target.value })}
          rows={4}
          className="font-mono text-sm"
          placeholder={"country\nregion\ncity"}
          data-testid="admin-semantic-model-add-levels"
        />
        <FieldError message={fieldErrors.levels} />
      </div>
    </>
  );
}

function ExposedField({
  exposed,
  onChange,
}: {
  exposed: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          Exposed to planner
        </label>
        <p className="text-xs text-muted-foreground/80">
          When off, the planner won&apos;t see this entry.
        </p>
      </div>
      <Switch
        checked={exposed}
        onCheckedChange={onChange}
        data-testid="admin-semantic-model-add-exposed"
      />
    </div>
  );
}
