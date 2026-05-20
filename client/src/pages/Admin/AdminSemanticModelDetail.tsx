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
import {
  fetchSemanticModelDetail,
  patchSemanticModel,
  type AdminSemanticModelDetail,
} from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "@/shared/schema";
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

function MetricRow({
  m,
  saving,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditExpression,
  onEditFormat,
  onEditCurrencyCode,
}: {
  m: SemanticMetric;
  saving: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditExpression: (next: string) => void;
  onEditFormat: (next: SemanticMetric["format"]) => void;
  onEditCurrencyCode: (next: string) => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="font-mono text-sm text-foreground">{m.name}</div>
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
    </tr>
  );
}

function DimensionRow({
  d,
  saving,
  onToggleExposed,
  onEditLabel,
  onEditDescription,
  onEditKind,
  onEditTemporalGrain,
}: {
  d: SemanticDimension;
  saving: boolean;
  onToggleExposed: (next: boolean) => void;
  onEditLabel: (next: string) => void;
  onEditDescription: (next: string) => void;
  onEditKind: (next: SemanticDimension["kind"]) => void;
  onEditTemporalGrain: (next: string) => void;
}) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4 space-y-2 min-w-[220px]">
        <div className="font-mono text-sm text-foreground">{d.name}</div>
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
    </tr>
  );
}

function HierarchyRow({ h }: { h: SemanticHierarchy }) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4">
        <div className="font-mono text-sm text-foreground">{h.name}</div>
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
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Metrics
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.metrics.length}
            </span>
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
                  </tr>
                </thead>
                <tbody>
                  {[...model.metrics]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((m) => (
                      <MetricRow
                        key={m.name}
                        m={m}
                        saving={saving}
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
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Dimensions
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.dimensions.length}
            </span>
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
                  </tr>
                </thead>
                <tbody>
                  {[...model.dimensions]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((d) => (
                      <DimensionRow
                        key={d.name}
                        d={d}
                        saving={saving}
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
                      />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Hierarchies
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.hierarchies.length}
            </span>
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
                  </tr>
                </thead>
                <tbody>
                  {[...model.hierarchies]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((h) => (
                      <HierarchyRow key={h.name} h={h} />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
