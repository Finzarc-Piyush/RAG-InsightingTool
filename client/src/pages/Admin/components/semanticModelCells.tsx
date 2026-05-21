/**
 * W61-host-extract · shared presentational cell primitives consumed by
 * the per-section card components (`MetricsCard` / `DimensionsCard` /
 * `HierarchiesCard`). Extracted verbatim from `AdminSemanticModelDetail.tsx`
 * so the host can shed ~545 LOC of presentational scaffolding before any
 * subsequent host-touching wave (W61-edit-column / W61-edit-references /
 * W61-per-section-filter). No JSX node changes, no prop-semantics changes;
 * the underlying pure helpers (`validateLabel` / `validateDescription` /
 * `isMeaningfulChange` / `getSourceBadgeLabel` etc.) are already pinned by
 * their respective W61 lib-test files.
 *
 * Why one shared cells file rather than co-locating each cell inside its
 * single-card consumer: `SourceBadge` + `RowDeleteButton` are used by all
 * three rows, and `EditableText` + `EditableSelect` are used by metric +
 * dimension rows. Splitting the cells across cards would duplicate ~200
 * LOC of presentational primitive and lose the canonical-source guarantee
 * that gives the row layouts identical typography / spacing / disabled
 * semantics.
 */

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { isMeaningfulChange } from "../lib/semanticModelEditValidation";
import {
  getSourceBadgeLabel,
  getSourceBadgeTooltip,
  getSourceBadgeVariant,
  type SemanticEntrySource,
} from "../lib/semanticModelSourceBadge";

interface ExposedToggleProps {
  exposed: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

export function ExposedToggle({
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
export function SourceBadge({ source }: { source: SemanticEntrySource }) {
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

export function EditableText({
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

export function EditableSelect<T extends string>({
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
export function RowDeleteButton({
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
