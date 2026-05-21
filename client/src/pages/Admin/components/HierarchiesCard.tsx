/**
 * W61-host-extract · `HierarchiesCard` — the "Hierarchies" section of
 * the admin semantic-model viewer (`AdminSemanticModelDetail.tsx`).
 * Extracted verbatim so the host can shed ~130 LOC (HierarchyRow +
 * the card JSX).
 *
 * Hierarchies don't have inline cell-level editing like metrics /
 * dimensions — admins reorder, rename, add, and remove levels through
 * the sibling `<HierarchyEditor>` modal (W61-hierarchy-edit). The row
 * therefore only exposes the per-row Edit2 icon button (opens the
 * modal) + the canonical RowDeleteButton; the host still owns the
 * `editingHierarchy` open-signal + the `editLevelsSubmitting` /
 * `editLevelsError` state slots.
 */

import { Edit2, Plus } from "lucide-react";
import type { SemanticHierarchy } from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  countEntriesBySource,
  filterEntriesBySource,
  type SemanticEntryFilter,
} from "../lib/semanticModelSourceFilter";
import { SourceFilterChips } from "./SourceFilterChips";
import { RowDeleteButton, SourceBadge } from "./semanticModelCells";

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

export interface HierarchiesCardProps {
  hierarchies: SemanticHierarchy[];
  sourceFilter: SemanticEntryFilter;
  onSourceFilterChange: (next: SemanticEntryFilter) => void;
  saving: boolean;
  deletePending: boolean;
  editLevelsPending: boolean;
  addDisabled: boolean;
  onAdd: () => void;
  onRequestDelete: (hierarchyName: string) => void;
  onRequestEditLevels: (hierarchy: SemanticHierarchy) => void;
}

export function HierarchiesCard({
  hierarchies,
  sourceFilter,
  onSourceFilterChange,
  saving,
  deletePending,
  editLevelsPending,
  addDisabled,
  onAdd,
  onRequestDelete,
  onRequestEditLevels,
}: HierarchiesCardProps) {
  return (
    <Card className="p-0 overflow-hidden">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-foreground">
          Hierarchies
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <SourceFilterChips
            active={sourceFilter}
            counts={countEntriesBySource(hierarchies)}
            onChange={onSourceFilterChange}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={addDisabled}
            onClick={onAdd}
            data-testid="admin-semantic-model-add-hierarchy-button"
          >
            <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Add hierarchy
          </Button>
        </div>
      </header>
      {hierarchies.length === 0 ? (
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
              {[...filterEntriesBySource(hierarchies, sourceFilter)]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((h) => (
                  <HierarchyRow
                    key={h.name}
                    h={h}
                    saving={saving}
                    deletePending={deletePending}
                    editLevelsPending={editLevelsPending}
                    onDelete={() => onRequestDelete(h.name)}
                    onEditLevels={() => onRequestEditLevels(h)}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
