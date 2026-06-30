import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { SummaryGroupConfig } from "../lib/summaryBandEdit";

/** W-SBCOLOR · swatch tints (card preview) + the solid dot per colour. */
const SWATCH_CLASSES: Record<string, string> = {
  green: "border-[hsl(var(--success)/0.5)] bg-[hsl(var(--success)/0.12)] text-foreground",
  amber: "border-amber-500/50 bg-amber-500/10 text-foreground",
  red: "border-destructive/50 bg-destructive/10 text-foreground",
};
const SWATCH_DOT: Record<string, string> = {
  green: "bg-[hsl(var(--success))]",
  amber: "bg-amber-500",
  red: "bg-destructive",
};

/**
 * Wave C4 · the generic field-driven editor for one Executive Summary band
 * card (any of the six groups). Stateless about persistence — it just collects
 * the dialog values and hands them back; `DashboardSummaryBand` builds the
 * patch and saves. Field shapes come from `SUMMARY_GROUPS[group]`.
 */
export interface SummaryItemDialogProps {
  open: boolean;
  mode: "add" | "edit";
  group: SummaryGroupConfig;
  initialValues: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  onClose: () => void;
}

export function SummaryItemDialog({
  open,
  mode,
  group,
  initialValues,
  onSave,
  onClose,
}: SummaryItemDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(initialValues);

  // Re-seed when the dialog (re)opens for a different item.
  useEffect(() => {
    if (open) setValues(initialValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group.key, JSON.stringify(initialValues)]);

  const set = (key: string, v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  // Required = every non-optional field has a non-empty value.
  const missingRequired = group.fields.some(
    (f) => !f.optional && !(values[f.key] ?? "").trim(),
  );

  const title = `${mode === "add" ? "Add" : "Edit"} ${group.singular}`;

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="capitalize">{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          {group.fields.map((f) => {
            const id = `summary-field-${group.key}-${f.key}`;
            return (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={id} className="text-xs">
                  {f.label}
                  {f.optional ? (
                    <span className="ml-1 text-muted-foreground">(optional)</span>
                  ) : null}
                </Label>
                {f.control === "color" ? (
                  // W-SBCOLOR · pick a card colour from labelled swatches.
                  <div className="flex gap-2" role="radiogroup" aria-label={f.label}>
                    {(f.options ?? []).map((o) => {
                      const selected = (values[f.key] ?? "") === o.value;
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          aria-label={o.label}
                          title={o.label}
                          onClick={() => set(f.key, o.value)}
                          className={cn(
                            "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-brand-sm border text-xs font-medium transition-all",
                            SWATCH_CLASSES[o.value] ?? "border-border",
                            selected
                              ? "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background"
                              : "opacity-70 hover:opacity-100",
                          )}
                        >
                          <span
                            className={cn("h-2.5 w-2.5 rounded-full", SWATCH_DOT[o.value])}
                            aria-hidden="true"
                          />
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                ) : f.control === "textarea" ? (
                  <Textarea
                    id={id}
                    rows={3}
                    value={values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                ) : f.control === "select" ? (
                  <Select
                    value={(values[f.key] ?? "") === "" ? "__none__" : values[f.key]}
                    onValueChange={(v) => set(f.key, v === "__none__" ? "" : v)}
                  >
                    <SelectTrigger id={id} className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(f.options ?? []).map((o) => (
                        // Radix Select disallows an empty-string value; map the
                        // "none" sentinel to a token and back on save.
                        <SelectItem key={o.value} value={o.value === "" ? "__none__" : o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={id}
                    type={f.control === "number" ? "number" : "text"}
                    value={values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={missingRequired}
            onClick={() => {
              // Normalize the Radix "none" sentinel back to empty string.
              const normalized: Record<string, string> = {};
              for (const [k, v] of Object.entries(values)) {
                normalized[k] = v === "__none__" ? "" : v;
              }
              onSave(normalized);
            }}
          >
            {mode === "add" ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
