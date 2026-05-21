/**
 * W61-detail · Admin · Per-session semantic-model viewer.
 *
 * Read-only render of the auto-inferred metrics, dimensions, and
 * hierarchies on a single session's `ChatDocument.semanticModel`. The
 * follow-on W61-save wave will add inline edit forms + a PATCH endpoint.
 *
 * Why structural React rendering rather than passing
 * `formatMetricCatalog`'s markdown string into `react-markdown`: the
 * client doesn't depend on `react-markdown`, the structural render
 * gives richer typography (`tabular-nums` for counts, `<code>` for
 * snake-case identifiers, monospace expressions, per-section headings),
 * and the planner-side manifest stays exact-byte for prompt-cache hits.
 * The duplication is real but small (3 column tables vs the manifest's
 * 4 line shapes per entry) and well-contained.
 */

import { useEffect, useRef, useState } from "react";
import { useRoute, useLocation } from "wouter";
import { Edit2, Plus, Trash2 } from "lucide-react";
import {
  addSemanticModelEntry,
  deleteSemanticModelEntry,
  fetchSemanticModelAuditLog,
  fetchSemanticModelDetail,
  NameAlreadyExistsError,
  patchSemanticModel,
  revertSemanticModel,
  type AdminSemanticModelAuditEntry,
  type AdminSemanticModelAuditLog,
  type AdminSemanticModelDetail,
  type AdminSemanticModelEntryKind,
} from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "@/shared/schema";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AdminNav } from "../Superadmin/AdminNav";
import {
  isMeaningfulChange,
  validateCurrencyCode,
  validateDescription,
  validateExpression,
  validateLabel,
} from "./lib/semanticModelEditValidation";
import {
  getSourceBadgeLabel,
  getSourceBadgeTooltip,
  getSourceBadgeVariant,
  type SemanticEntrySource,
} from "./lib/semanticModelSourceBadge";
import {
  countEntriesBySource,
  filterEntriesBySource,
  type SemanticEntryFilter,
} from "./lib/semanticModelSourceFilter";
import {
  readFilterFromSearch,
  writeFilterToSearch,
} from "./lib/semanticModelFilterUrlSync";
import { buildRevertConfirmation } from "./lib/semanticModelAuditHistory";
import { SourceFilterChips } from "./components/SourceFilterChips";
import { AuditHistoryCard } from "./components/AuditHistoryCard";
import { DeleteEntryConfirmation } from "./components/DeleteEntryConfirmation";
import { AddEntryForm } from "./components/AddEntryForm";
import { HierarchyEditor } from "./components/HierarchyEditor";

/**
 * W61-edit-enums · enum option pickers for the admin viewer. Values
 * must stay byte-exact to the zod enums in
 * [`semanticMetricSchema`](../../../server/shared/schema.ts) /
 * [`semanticDimensionSchema`](../../../server/shared/schema.ts);
 * the server's `safeParse` is the authoritative source and a typo
 * here would round-trip to a 400 with the invalid-enum issue
 * surfacing in the existing "Save failed" banner.
 */
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

/**
 * `temporalGrain` is `.optional()` on the schema; Radix Select can't
 * carry an empty-string value, so a `__auto__` sentinel maps to
 * `undefined` at the save boundary (lets the agent's
 * `temporalFacetColumns` derivation still pick the grain from data).
 */
const TEMPORAL_GRAIN_AUTO = "__auto__" as const;
const TEMPORAL_GRAIN_OPTIONS = [
  { value: TEMPORAL_GRAIN_AUTO, label: "Auto (let agent derive)" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
] as const;

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return `${Math.round(delta / 86400_000)}d ago`;
}

function formatHint(m: SemanticMetric): string {
  const parts: string[] = [m.format];
  if (m.format === "currency" && m.currencyCode) {
    parts[0] = `currency (${m.currencyCode})`;
  }
  if (m.decimals !== undefined) {
    parts.push(`${m.decimals} dp`);
  }
  return parts.join(", ");
}

interface ExposedToggleProps {
  exposed: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

function ExposedToggle({
  exposed,
  disabled,
  onChange,
  ariaLabel,
}: ExposedToggleProps) {
  return (
    <Switch
      checked={exposed}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
    />
  );
}

/**
 * W61-source-badge · Chip surfacing each entry's provenance — auto
 * (muted), user (primary), domain (gold accent). Renders sibling to
 * the entry name so the admin can scan a column of `<name>  <chip>`
 * pairs and spot which entries they've already corrected.
 *
 * Sizing tuned smaller than the canonical Badge so the chip reads as
 * metadata next to the snake-case identifier rather than competing
 * with it (`px-1.5 py-0` + `text-[10px]` + `h-4`). Native `title=`
 * tooltip — Tooltip primitive would add a wrapping provider mount
 * without any UX win at this density.
 */
function SourceBadge({ source }: { source: SemanticEntrySource }) {
  return (
    <Badge
      variant={getSourceBadgeVariant(source)}
      title={getSourceBadgeTooltip(source)}
      className="px-1.5 py-0 h-4 text-[10px] font-medium"
    >
      {getSourceBadgeLabel(source)}
    </Badge>
  );
}

/**
 * W61-edit-text · Inline-editable text cell.
 *
 * Always-editable (no click-to-edit dance): the input is the cell.
 * Save-on-blur: when the field loses focus, if validation passes and
 * the trimmed value differs from prop value, fires `onSave` which
 * triggers an optimistic update + PATCH in the parent. Enter blurs
 * (single-line only); Escape discards the draft.
 *
 * The prop `value` is the source of truth — when the server's
 * authoritative reply lands, a `useEffect` re-syncs `draft` so a
 * server-side normalisation (e.g. trimmed whitespace) is reflected.
 * If validation fails on blur, the draft resets to the last-known
 * server value rather than persisting an invalid local state.
 */
interface EditableTextProps {
  value: string;
  onSave: (next: string) => void;
  validate: (s: string) => string | null;
  disabled: boolean;
  ariaLabel: string;
  multiline?: boolean;
  monospace?: boolean;
  placeholder?: string;
}

function EditableText({
  value,
  onSave,
  validate,
  disabled,
  ariaLabel,
  multiline,
  monospace,
  placeholder,
}: EditableTextProps) {
  const [draft, setDraft] = useState<string>(value);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [value]);

  function handleChange(next: string): void {
    setDraft(next);
    setError(validate(next));
  }

  function handleBlur(): void {
    if (error) {
      setDraft(value);
      setError(null);
      return;
    }
    if (!isMeaningfulChange(value, draft)) {
      setDraft(value);
      return;
    }
    onSave(draft.trim());
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): void {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      inputRef.current?.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDraft(value);
      setError(null);
      inputRef.current?.blur();
    }
  }

  const sharedProps = {
    value: draft,
    disabled,
    "aria-label": ariaLabel,
    "aria-invalid": error ? true : undefined,
    placeholder,
    onChange: (e: { target: { value: string } }) => handleChange(e.target.value),
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
  } as const;

  const errorClass = error
    ? "border-destructive/60 focus-visible:ring-destructive/40 focus-visible:border-destructive/80"
    : "";
  const monoClass = monospace ? "font-mono text-xs" : "text-sm";

  return (
    <div className="space-y-1">
      {multiline ? (
        <Textarea
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          className={cn("min-h-[60px]", monoClass, errorClass)}
          {...sharedProps}
        />
      ) : (
        <Input
          ref={inputRef as React.Ref<HTMLInputElement>}
          className={cn("h-8", monoClass, errorClass)}
          {...sharedProps}
        />
      )}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * W61-edit-enums · Save-on-select wrapper around Radix `<Select>`.
 *
 * Unlike `EditableText` there's no draft / validation step — every
 * option is by-construction valid (the option list is byte-locked to
 * the zod enum). `onValueChange` fires `onSave` directly and the
 * parent's optimistic-update-and-PATCH flow handles the rest.
 *
 * The `value` prop is `string | undefined`; Radix `<Select>` accepts
 * `value={undefined}` which renders the placeholder. Used by the
 * temporal-grain cell where the "Auto" sentinel is passed through.
 */
interface EditableSelectProps<T extends string> {
  value: T | undefined;
  options: ReadonlyArray<{ value: T; label: string }>;
  onSave: (next: T) => void;
  disabled: boolean;
  ariaLabel: string;
  placeholder?: string;
}

function EditableSelect<T extends string>({
  value,
  options,
  onSave,
  disabled,
  ariaLabel,
  placeholder,
}: EditableSelectProps<T>) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onSave(v as T)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 text-sm" aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder ?? "Select…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * W61-delete-client · per-row Delete button consumed by every entry
 * row (`MetricRow` / `DimensionRow` / `HierarchyRow`). The host owns
 * the destructive-op state; this is a presentational wrapper around
 * the ghost-variant `<Button>` so the three rows render the
 * destructive affordance identically (icon, label, disabled gate
 * semantics).
 */
function RowDeleteButton({
  onDelete,
  disabled,
  ariaLabel,
}: {
  onDelete: () => void;
  disabled: boolean;
  ariaLabel: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
      disabled={disabled}
      onClick={onDelete}
      aria-label={ariaLabel}
      data-testid={ariaLabel}
    >
      <Trash2 className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}

function MetricRow({
  m,
  saving,
  deletePending,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditExpression,
  onEditFormat,
  onEditCurrencyCode,
  onDelete,
}: {
  m: SemanticMetric;
  saving: boolean;
  deletePending: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditExpression: (next: string) => void;
  onEditFormat: (next: SemanticMetric["format"]) => void;
  onEditCurrencyCode: (next: string) => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-foreground">{m.name}</div>
          <SourceBadge source={m.source} />
        </div>
        <EditableText
          value={m.label}
          onSave={onEditLabel}
          validate={validateLabel}
          disabled={saving}
          ariaLabel={`Edit label for metric ${m.name}`}
        />
        <EditableText
          value={m.description ?? ""}
          onSave={onEditDescription}
          validate={validateDescription}
          disabled={saving}
          ariaLabel={`Edit description for metric ${m.name}`}
          multiline
          placeholder="Description (shown to the planner)…"
        />
      </td>
      <td className="py-3 px-4 min-w-[220px]">
        <EditableText
          value={m.expression}
          onSave={onEditExpression}
          validate={validateExpression}
          disabled={saving}
          ariaLabel={`Edit expression for metric ${m.name}`}
          monospace
        />
      </td>
      <td className="py-3 px-4 min-w-[160px] space-y-2">
        <EditableSelect
          value={m.format}
          options={METRIC_FORMAT_OPTIONS}
          onSave={onEditFormat}
          disabled={saving}
          ariaLabel={`Edit format for metric ${m.name}`}
        />
        {m.format === "currency" ? (
          <EditableText
            value={m.currencyCode ?? ""}
            onSave={onEditCurrencyCode}
            validate={validateCurrencyCode}
            disabled={saving}
            ariaLabel={`Edit currency code for metric ${m.name}`}
            monospace
            placeholder="USD / INR / EUR"
          />
        ) : null}
        {m.decimals !== undefined ? (
          <div className="text-xs text-muted-foreground">
            {m.decimals} dp
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {m.references.length === 0 ? "—" : m.references.join(", ")}
      </td>
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={m.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${m.label} exposed`}
        />
      </td>
      <td className="py-3 px-4">
        <RowDeleteButton
          onDelete={onDelete}
          disabled={saving || deletePending}
          ariaLabel={`Delete metric ${m.name}`}
        />
      </td>
    </tr>
  );
}

function DimensionRow({
  d,
  saving,
  deletePending,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditKind,
  onEditTemporalGrain,
  onDelete,
}: {
  d: SemanticDimension;
  saving: boolean;
  deletePending: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditKind: (next: SemanticDimension["kind"]) => void;
  onEditTemporalGrain: (next: string) => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-foreground">{d.name}</div>
          <SourceBadge source={d.source} />
        </div>
        <EditableText
          value={d.label}
          onSave={onEditLabel}
          validate={validateLabel}
          disabled={saving}
          ariaLabel={`Edit label for dimension ${d.name}`}
        />
        <EditableText
          value={d.description ?? ""}
          onSave={onEditDescription}
          validate={validateDescription}
          disabled={saving}
          ariaLabel={`Edit description for dimension ${d.name}`}
          multiline
          placeholder="Description (shown to the planner)…"
        />
      </td>
      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
        {d.column}
      </td>
      <td className="py-3 px-4 min-w-[180px] space-y-2">
        <EditableSelect
          value={d.kind}
          options={DIMENSION_KIND_OPTIONS}
          onSave={onEditKind}
          disabled={saving}
          ariaLabel={`Edit kind for dimension ${d.name}`}
        />
        {d.kind === "temporal" ? (
          <EditableSelect
            value={d.temporalGrain ?? TEMPORAL_GRAIN_AUTO}
            options={TEMPORAL_GRAIN_OPTIONS}
            onSave={onEditTemporalGrain}
            disabled={saving}
            ariaLabel={`Edit temporal grain for dimension ${d.name}`}
          />
        ) : null}
      </td>
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={d.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${d.label} exposed`}
        />
      </td>
      <td className="py-3 px-4">
        <RowDeleteButton
          onDelete={onDelete}
          disabled={saving || deletePending}
          ariaLabel={`Delete dimension ${d.name}`}
        />
      </td>
    </tr>
  );
}

function HierarchyRow({
  h,
  saving,
  deletePending,
  editLevelsPending,
  onDelete,
  onEditLevels,
}: {
  h: SemanticHierarchy;
  saving: boolean;
  deletePending: boolean;
  editLevelsPending: boolean;
  onDelete: () => void;
  onEditLevels: () => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4">
        <div className="flex items-center gap-2">
          <div className="font-mono text-sm text-foreground">{h.name}</div>
          <SourceBadge source={h.source} />
        </div>
        <div className="text-xs text-muted-foreground">{h.label}</div>
        {h.description ? (
          <div className="text-xs text-muted-foreground mt-1 italic">
            {h.description}
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {h.levels.join(" → ")}
      </td>
      <td className="py-3 px-4">
        <div className="flex items-center gap-1">
          {/* W61-hierarchy-edit · per-row edit button opens the
              HierarchyEditor modal. Placed before the delete button
              so the non-destructive action reads first. */}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            disabled={saving || deletePending || editLevelsPending}
            onClick={onEditLevels}
            aria-label={`Edit levels for ${h.name}`}
            data-testid={`Edit levels for ${h.name}`}
          >
            <Edit2 className="h-4 w-4" aria-hidden="true" />
          </Button>
          <RowDeleteButton
            onDelete={onDelete}
            disabled={saving || deletePending || editLevelsPending}
            ariaLabel={`Delete hierarchy ${h.name}`}
          />
        </div>
      </td>
    </tr>
  );
}

export default function AdminSemanticModelDetail() {
  const [, params] = useRoute<{ sessionId: string }>(
    "/admin/semantic-models/:sessionId",
  );
  const [, setLocation] = useLocation();
  const sessionId = params?.sessionId ?? "";
  const [data, setData] = useState<AdminSemanticModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Wave W61-save · saving status surfaces a banner + disables every
  // toggle while a PATCH is in flight. A single shared flag is cheaper
  // than per-row state and matches "auto-save on toggle" UX (the user
  // shouldn't fire two PATCHes at once anyway since the second would
  // race the first's response into the cache).
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Wave W61-source-filter · one global filter across metrics +
  // dimensions + hierarchies. Most-common workflow is "show me what
  // I edited" applied uniformly across all three sections; a per-card
  // filter would force three clicks for the same effect.
  //
  // Wave W61-filter-persist · the initial state reads from
  // `?filter=X` so a share-link or accidental-reload preserves the
  // active chip. The `useState` lazy initializer runs once on mount;
  // a downstream `useEffect` keeps the URL in sync on every change.
  const [sourceFilter, setSourceFilter] = useState<SemanticEntryFilter>(() =>
    typeof window === "undefined"
      ? "all"
      : readFilterFromSearch(window.location.search),
  );

  // Wave W61-audit-history-tab · collapsible "Audit history" section
  // state. Closed by default so the buffer fetch is opt-in — most
  // detail-page visits never open it. A single global `reverting`
  // index lets the per-row Revert buttons show in-flight state on
  // just the clicked row; other rows remain readable / clickable.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLog, setHistoryLog] = useState<AdminSemanticModelAuditLog | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Wave W61-delete-client · per-row delete state. `pendingDelete` is
  // the modal's open-or-closed signal — a non-null value renders the
  // confirmation modal, which in turn fetches the W61-references
  // count. `deletingEntry` is the in-flight mutation state (set while
  // the DELETE round-trip is pending) — disables every Delete button
  // to prevent the admin queueing up overlapping destructive ops.
  // A single `deleteError` slot scopes the failure to the modal body
  // rather than a page-level banner, matching the
  // `AlertDialogDescription` rendering shape.
  const [pendingDelete, setPendingDelete] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Wave W61-add-client · per-card add-entry state. `addOpen` is the
  // modal's open-or-closed signal — a non-null value renders the
  // AddEntryForm dialog for the matching kind. `addSubmitting` is the
  // in-flight mutation state (set while the POST round-trip is
  // pending). `addError` / `addNameCollision` scope failure surfaces
  // to the modal body — collision is the typed 409 case (rendered
  // inline under the name field by the form), generic submit error is
  // any other non-2xx.
  const [addOpen, setAddOpen] = useState<AdminSemanticModelEntryKind | null>(
    null,
  );
  const [addSubmitting, setAddSubmitting] =
    useState<AdminSemanticModelEntryKind | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addNameCollision, setAddNameCollision] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);

  // Wave W61-hierarchy-edit · per-hierarchy levels-edit state.
  // `editingHierarchy` is the modal's open-signal — a non-null value
  // renders the HierarchyEditor modal with that hierarchy's levels
  // seeded into the draft. `editLevelsSubmitting` is the in-flight
  // flag (the hierarchy's `name` while the PATCH round-trip is
  // pending — same shape as `deletingEntry` so the row's per-mutation
  // gate doesn't conflict with other write mutations); `editLevelsError`
  // scopes the failure surface to the modal body.
  const [editingHierarchy, setEditingHierarchy] =
    useState<SemanticHierarchy | null>(null);
  const [editLevelsSubmitting, setEditLevelsSubmitting] =
    useState<string | null>(null);
  const [editLevelsError, setEditLevelsError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextSearch = writeFilterToSearch(
      window.location.search,
      sourceFilter,
    );
    const nextUrl =
      window.location.pathname +
      (nextSearch ? "?" + nextSearch : "") +
      window.location.hash;
    // `replaceState` rather than `pushState` so each chip click
    // doesn't accumulate a browser history entry — back-button
    // behaviour stays predictable (one entry per page visit, not
    // one per filter toggle).
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [sourceFilter]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSemanticModelDetail(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Wave W61-audit-history-tab · fetch the prior-model ring buffer
  // when the admin opens the section, AND re-fetch whenever the
  // parent doc's `lastUpdatedAt` bumps (which happens on save or
  // revert — both grow the buffer by one entry, so the open list
  // would otherwise show stale state). Gated by `historyOpen` so
  // closed-section visits never pay the Cosmos round-trip.
  const lastUpdatedAt = data?.lastUpdatedAt;
  useEffect(() => {
    if (!sessionId || !historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchSemanticModelAuditLog(sessionId)
      .then((log) => {
        if (!cancelled) setHistoryLog(log);
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, historyOpen, lastUpdatedAt]);

  async function persistModel(nextModel: SemanticModel): Promise<void> {
    if (!data) return;
    // Optimistic update so the toggle responds instantly.
    const prior = data;
    setData({ ...prior, model: nextModel });
    setSaving(true);
    setSaveError(null);
    try {
      const res = await patchSemanticModel(sessionId, nextModel);
      // Reconcile with the server's authoritative view (version bump,
      // updatedAt / updatedBy stamping that the server controls).
      setData({
        ...prior,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
    } catch (err) {
      // Roll back the optimistic toggle.
      setData(prior);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleToggleMetricExposed(metricName: string, next: boolean): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      metrics: data.model.metrics.map((m) =>
        m.name === metricName ? { ...m, exposed: next } : m,
      ),
    };
    void persistModel(nextModel);
  }

  function handleToggleDimensionExposed(
    dimensionName: string,
    next: boolean,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      dimensions: data.model.dimensions.map((d) =>
        d.name === dimensionName ? { ...d, exposed: next } : d,
      ),
    };
    void persistModel(nextModel);
  }

  /**
   * W61-edit-text · One handler per (entity, text-field) — keeps the
   * patch shape narrow so the optimistic update touches only the
   * edited cell. Description sets to `undefined` rather than the
   * empty string so the round-trip matches the zod schema's
   * `.optional()` (empty strings would re-emit on the server and
   * subtly drift the doc shape).
   */
  function patchMetric(
    metricName: string,
    patch: Partial<SemanticMetric>,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      metrics: data.model.metrics.map((m) =>
        m.name === metricName ? { ...m, ...patch } : m,
      ),
    };
    void persistModel(nextModel);
  }

  function patchDimension(
    dimensionName: string,
    patch: Partial<SemanticDimension>,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      dimensions: data.model.dimensions.map((d) =>
        d.name === dimensionName ? { ...d, ...patch } : d,
      ),
    };
    void persistModel(nextModel);
  }

  function emptyToUndef(s: string): string | undefined {
    const trimmed = s.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  /**
   * W61-edit-enums · clears `currencyCode` when the admin switches
   * away from `format: "currency"` — the field is meaningless without
   * the currency format, and leaving the stale code would surface in
   * the planner manifest as a misleading "(USD)" hint on a percent or
   * ratio metric. Server's `safeParse` doesn't strip it on its own.
   */
  function handleMetricFormatChange(
    metricName: string,
    nextFormat: SemanticMetric["format"],
  ): void {
    const patch: Partial<SemanticMetric> = { format: nextFormat };
    if (nextFormat !== "currency") {
      patch.currencyCode = undefined;
    }
    patchMetric(metricName, patch);
  }

  /**
   * W61-edit-enums · clears `temporalGrain` when the admin switches
   * away from `kind: "temporal"` — the grain only makes sense paired
   * with a temporal dimension, and a stale grain on a `categorical`
   * dimension would confuse the planner. The agent's
   * `temporalFacetColumns` derivation is the fallback when grain is
   * undefined and the kind IS temporal.
   */
  function handleDimensionKindChange(
    dimensionName: string,
    nextKind: SemanticDimension["kind"],
  ): void {
    const patch: Partial<SemanticDimension> = { kind: nextKind };
    if (nextKind !== "temporal") {
      patch.temporalGrain = undefined;
    }
    patchDimension(dimensionName, patch);
  }

  /**
   * W61-edit-enums · the `__auto__` sentinel from `TEMPORAL_GRAIN_OPTIONS`
   * maps to `undefined` at the save boundary; any concrete grain
   * (day / week / month / quarter / year) flows through as-is.
   */
  function handleTemporalGrainChange(
    dimensionName: string,
    nextGrain: string,
  ): void {
    const grain =
      nextGrain === TEMPORAL_GRAIN_AUTO
        ? undefined
        : (nextGrain as SemanticDimension["temporalGrain"]);
    patchDimension(dimensionName, { temporalGrain: grain });
  }

  /**
   * W61-audit-history-tab · revert affordance for a single audit
   * entry. The 0-based `indexFromNewest` matches the buffer's
   * newest-first ordering (so `0` is "undo my last save"). On success
   * we update `data` with the response envelope (byte-identical to
   * the W61-save shape — see `revertSemanticModel` in admin.ts); the
   * `data.lastUpdatedAt` bump triggers the audit-log re-fetch
   * effect above, which re-reads the now-grown buffer (the prior
   * current model was appended by the server's revert handler).
   */
  async function handleRevert(
    entry: AdminSemanticModelAuditEntry,
    indexFromNewest: number,
    total: number,
  ): Promise<void> {
    if (!data || reverting !== null) return;
    const prompt = buildRevertConfirmation(entry, indexFromNewest, total);
    if (typeof window !== "undefined" && !window.confirm(prompt)) return;
    setReverting(indexFromNewest);
    setRevertError(null);
    try {
      const res = await revertSemanticModel(sessionId, indexFromNewest);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err));
    } finally {
      setReverting(null);
    }
  }

  /**
   * W61-delete-client · destructive op that removes a single entry
   * from the model. Mirrors the W61-audit-revert handler shape: a
   * single global in-flight flag (`deletingEntry`) prevents overlap;
   * the server returns the W61-save envelope so the success branch
   * reuses the same `setData` shape as PATCH / revert.
   *
   * The `data.lastUpdatedAt` bump triggers the audit-history-tab's
   * re-fetch effect — which is load-bearing, because the server
   * snapshotted the pre-delete model into the audit log so "undo
   * this delete via revert" works (per the W61 destructive-op +
   * audit-write-before-mutation convention).
   *
   * On success the modal is closed via `setPendingDelete(null)`;
   * on failure it stays open with `deleteError` populated so the
   * admin can read the error and either retry or cancel.
   */
  async function handleDelete(
    kind: AdminSemanticModelEntryKind,
    name: string,
  ): Promise<void> {
    if (!data || deletingEntry !== null) return;
    setDeletingEntry({ kind, name });
    setDeleteError(null);
    try {
      const res = await deleteSemanticModelEntry(sessionId, kind, name);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntry(null);
    }
  }

  /**
   * W61-add-client · additive op that appends a single new entry to
   * the model. Mirrors the W61-delete-client handler shape: a single
   * global in-flight flag (`addSubmitting`) prevents overlap; the
   * server returns the W61-save envelope so the success branch reuses
   * the same `setData` shape as PATCH / revert / delete.
   *
   * On 409 (name collision per kind) the typed
   * `NameAlreadyExistsError` is caught via `instanceof` and surfaces
   * inline under the modal's name field via `setAddNameCollision`.
   * Generic non-2xx surfaces via `setAddError` at the bottom of the
   * modal body. On success the modal is closed via `setAddOpen(null)`
   * and the `data.lastUpdatedAt` bump triggers the audit-history-tab's
   * re-fetch effect (the server snapshotted the pre-add model so
   * "undo this add via revert" works).
   */
  async function handleAdd(
    kind: AdminSemanticModelEntryKind,
    entry: SemanticMetric | SemanticDimension | SemanticHierarchy,
  ): Promise<void> {
    if (!data || addSubmitting !== null) return;
    setAddSubmitting(kind);
    setAddError(null);
    setAddNameCollision(null);
    try {
      const res = await addSemanticModelEntry(sessionId, kind, entry);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setAddOpen(null);
    } catch (err) {
      if (err instanceof NameAlreadyExistsError) {
        setAddNameCollision({ kind: err.kind, name: err.entryName });
      } else {
        setAddError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setAddSubmitting(null);
    }
  }

  /**
   * Wave W61-hierarchy-edit · save the edited levels for the selected
   * hierarchy. Reuses the existing W61-save PATCH path
   * (`patchSemanticModel`) because hierarchies don't have a dedicated
   * endpoint — the modal hands back the new ordered levels array, we
   * build a `nextModel` with `hierarchies` re-mapped to swap in the
   * new levels for the matching name, and route through the wholesale
   * replace path. The server's W61-save handler runs the normal version
   * bump + audit-log + invalidation hook (W61-cache-invalidate) flow.
   *
   * Mirrors the W61-add-client `handleAdd` shape: own submitting flag,
   * own error slot, success path updates parent `data` (which causes
   * the audit-history-tab's `lastUpdatedAt`-keyed effect to re-fetch
   * the buffer so the pre-edit snapshot appears for revert-as-undo).
   */
  async function handleEditHierarchyLevels(
    hierarchyName: string,
    nextLevels: string[],
  ): Promise<void> {
    if (!data || editLevelsSubmitting !== null) return;
    setEditLevelsSubmitting(hierarchyName);
    setEditLevelsError(null);
    try {
      const nextModel: SemanticModel = {
        ...data.model,
        hierarchies: data.model.hierarchies.map((h) =>
          h.name === hierarchyName ? { ...h, levels: nextLevels } : h,
        ),
      };
      const res = await patchSemanticModel(sessionId, nextModel);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setEditingHierarchy(null);
    } catch (err) {
      setEditLevelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditLevelsSubmitting(null);
    }
  }

  if (loading && !data) {
    return (
      <>
        <AdminNav />
        <div
          className="p-6 text-muted-foreground"
          data-testid="admin-semantic-model-detail-loading"
        >
          Loading semantic model for {sessionId}…
        </div>
      </>
    );
  }

  if (error) {
    const isForbidden = /\b403\b/.test(error);
    const isNotFound = /\b404\b/.test(error);
    return (
      <>
        <AdminNav />
        <div className="p-6">
          <Card className="p-6 border-destructive/30">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {isForbidden
                ? "Not authorized"
                : isNotFound
                ? "Semantic model not found"
                : "Failed to load semantic model"}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {isForbidden
                ? "Your account isn't on the admin allow-list."
                : isNotFound
                ? "Either the session id is invalid, or this session pre-dates the W57 inference pipeline and has no semantic model."
                : error}
            </p>
            <Button
              onClick={() => setLocation("/admin/semantic-models")}
              variant="outline"
            >
              Back to index
            </Button>
          </Card>
        </div>
      </>
    );
  }

  if (!data) return null;

  const { model } = data;
  const totalDeclarations =
    model.metrics.length + model.dimensions.length + model.hierarchies.length;

  return (
    <>
      <AdminNav />
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <header className="space-y-2">
          <Button
            onClick={() => setLocation("/admin/semantic-models")}
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2"
          >
            ← Back to index
          </Button>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                {model.name}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Session{" "}
                <span className="font-mono">{data.sessionId}</span> ·{" "}
                {data.fileName || "(unnamed dataset)"} · owned by{" "}
                {data.username || "(unknown)"}
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              v{model.version} · session last updated{" "}
              {formatRelative(data.lastUpdatedAt)}
              {model.updatedBy ? (
                <div>
                  Model last edited by {model.updatedBy}
                  {model.updatedAt
                    ? ` at ${new Date(model.updatedAt).toLocaleString()}`
                    : ""}
                </div>
              ) : (
                <div>Auto-inferred (never manually edited)</div>
              )}
            </div>
          </div>
        </header>

        {saving ? (
          <Card className="p-3 border-primary/30 bg-primary/5 text-sm text-foreground">
            Saving…
          </Card>
        ) : null}
        {saveError ? (
          <Card className="p-3 border-destructive/30 bg-destructive/5 text-sm text-destructive">
            Save failed: {saveError}. Change rolled back; try again.
          </Card>
        ) : null}

        {totalDeclarations === 0 ? (
          <Card className="p-6 border-border/50">
            <p className="text-sm text-muted-foreground">
              The model has no declared metrics, dimensions, or hierarchies.
              The planner will fall back to raw{" "}
              <code className="bg-muted/40 px-1 rounded">
                execute_query_plan
              </code>{" "}
              against the dataset schema.
            </p>
          </Card>
        ) : null}

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-foreground">
              Metrics
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <SourceFilterChips
                active={sourceFilter}
                counts={countEntriesBySource(model.metrics)}
                onChange={setSourceFilter}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={
                  saving ||
                  addSubmitting !== null ||
                  deletingEntry !== null ||
                  reverting !== null
                }
                onClick={() => setAddOpen("metric")}
                data-testid="admin-semantic-model-add-metric-button"
              >
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Add metric
              </Button>
            </div>
          </header>
          {model.metrics.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No metrics declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Expression</th>
                    <th className="py-3 px-4">Format</th>
                    <th className="py-3 px-4">References</th>
                    <th className="py-3 px-4">Exposed</th>
                    <th className="py-3 px-4">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...filterEntriesBySource(model.metrics, sourceFilter)]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((m) => (
                      <MetricRow
                        key={m.name}
                        m={m}
                        saving={saving}
                        deletePending={deletingEntry !== null}
                        onToggleExposed={(next) =>
                          handleToggleMetricExposed(m.name, next)
                        }
                        onEditLabel={(next) =>
                          patchMetric(m.name, { label: next })
                        }
                        onEditDescription={(next) =>
                          patchMetric(m.name, {
                            description: emptyToUndef(next),
                          })
                        }
                        onEditExpression={(next) =>
                          patchMetric(m.name, { expression: next })
                        }
                        onEditFormat={(next) =>
                          handleMetricFormatChange(m.name, next)
                        }
                        onEditCurrencyCode={(next) =>
                          patchMetric(m.name, {
                            currencyCode: emptyToUndef(next),
                          })
                        }
                        onDelete={() =>
                          setPendingDelete({ kind: "metric", name: m.name })
                        }
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-foreground">
              Dimensions
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <SourceFilterChips
                active={sourceFilter}
                counts={countEntriesBySource(model.dimensions)}
                onChange={setSourceFilter}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={
                  saving ||
                  addSubmitting !== null ||
                  deletingEntry !== null ||
                  reverting !== null
                }
                onClick={() => setAddOpen("dimension")}
                data-testid="admin-semantic-model-add-dimension-button"
              >
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Add dimension
              </Button>
            </div>
          </header>
          {model.dimensions.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No dimensions declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Column</th>
                    <th className="py-3 px-4">Kind</th>
                    <th className="py-3 px-4">Exposed</th>
                    <th className="py-3 px-4">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...filterEntriesBySource(model.dimensions, sourceFilter)]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((d) => (
                      <DimensionRow
                        key={d.name}
                        d={d}
                        saving={saving}
                        deletePending={deletingEntry !== null}
                        onToggleExposed={(next) =>
                          handleToggleDimensionExposed(d.name, next)
                        }
                        onEditLabel={(next) =>
                          patchDimension(d.name, { label: next })
                        }
                        onEditDescription={(next) =>
                          patchDimension(d.name, {
                            description: emptyToUndef(next),
                          })
                        }
                        onEditKind={(next) =>
                          handleDimensionKindChange(d.name, next)
                        }
                        onEditTemporalGrain={(next) =>
                          handleTemporalGrainChange(d.name, next)
                        }
                        onDelete={() =>
                          setPendingDelete({ kind: "dimension", name: d.name })
                        }
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-base font-semibold text-foreground">
              Hierarchies
            </h2>
            <div className="flex items-center gap-3 flex-wrap">
              <SourceFilterChips
                active={sourceFilter}
                counts={countEntriesBySource(model.hierarchies)}
                onChange={setSourceFilter}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={
                  saving ||
                  addSubmitting !== null ||
                  deletingEntry !== null ||
                  reverting !== null
                }
                onClick={() => setAddOpen("hierarchy")}
                data-testid="admin-semantic-model-add-hierarchy-button"
              >
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Add hierarchy
              </Button>
            </div>
          </header>
          {model.hierarchies.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No hierarchies declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Levels (top → bottom)</th>
                    <th className="py-3 px-4">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...filterEntriesBySource(model.hierarchies, sourceFilter)]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((h) => (
                      <HierarchyRow
                        key={h.name}
                        h={h}
                        saving={saving}
                        deletePending={deletingEntry !== null}
                        editLevelsPending={editLevelsSubmitting !== null}
                        onDelete={() =>
                          setPendingDelete({
                            kind: "hierarchy",
                            name: h.name,
                          })
                        }
                        onEditLevels={() => setEditingHierarchy(h)}
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <AuditHistoryCard
          historyOpen={historyOpen}
          onOpenChange={setHistoryOpen}
          historyLog={historyLog}
          historyLoading={historyLoading}
          historyError={historyError}
          revertError={revertError}
          reverting={reverting}
          saving={saving}
          onRevert={(entry, idx, total) =>
            void handleRevert(entry, idx, total)
          }
        />
      </div>
      <DeleteEntryConfirmation
        pending={pendingDelete}
        sessionId={sessionId}
        deleting={deletingEntry !== null}
        deleteError={deleteError}
        onOpenChange={(next) => {
          // While a delete is in flight, swallow dismiss attempts —
          // the destructive op should resolve before the modal goes
          // away so the admin can see the success / failure result.
          if (!next && deletingEntry !== null) return;
          if (!next) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => {
          if (!pendingDelete) return;
          void handleDelete(pendingDelete.kind, pendingDelete.name);
        }}
      />
      <AddEntryForm
        open={addOpen}
        submitting={addSubmitting !== null}
        submitError={addError}
        nameCollision={addNameCollision}
        onOpenChange={(next) => {
          // While an add is in flight, swallow dismiss attempts so the
          // admin sees the success / failure result inline (same
          // shape as DeleteEntryConfirmation).
          if (!next && addSubmitting !== null) return;
          if (!next) {
            setAddOpen(null);
            setAddError(null);
            setAddNameCollision(null);
          }
        }}
        onConfirm={(kind, entry) => {
          void handleAdd(kind, entry);
        }}
      />
      <HierarchyEditor
        hierarchy={editingHierarchy}
        submitting={editLevelsSubmitting !== null}
        submitError={editLevelsError}
        onOpenChange={(next) => {
          // While an edit is in flight, swallow dismiss attempts so
          // the admin sees the success / failure result inline (same
          // pattern as AddEntryForm + DeleteEntryConfirmation).
          if (!next && editLevelsSubmitting !== null) return;
          if (!next) {
            setEditingHierarchy(null);
            setEditLevelsError(null);
          }
        }}
        onConfirm={(name, nextLevels) => {
          void handleEditHierarchyLevels(name, nextLevels);
        }}
      />
    </>
  );
}
