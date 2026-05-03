import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Trash2 } from 'lucide-react';
import { PivotGrid } from '@/pages/Home/Components/pivot/PivotGrid';
import { flattenPivotTree } from '@/lib/pivot/buildPivotModel';
import { pivotQuery } from '@/lib/api/data';
import type {
  DashboardPivotSpec,
  PivotModel,
  PivotQueryRequest,
} from '@/shared/schema';

export interface PivotTileProps {
  pivot: DashboardPivotSpec;
  /** Session whose DuckDB serves pivot data. Falls back to the pivot's own
   *  `sourceSessionId` when not supplied by the parent. */
  sessionId?: string | null;
  canEdit?: boolean;
  onDelete?: () => void;
}

function pivotConfigToQueryRequest(
  pivot: DashboardPivotSpec
): PivotQueryRequest | null {
  const cfg = pivot.pivotConfig;
  if (!cfg) return null;
  if (!cfg.values || cfg.values.length === 0) return null;

  const sliceFields = new Set<string>();
  for (const f of cfg.filters ?? []) sliceFields.add(f);
  for (const f of cfg.rows ?? []) sliceFields.add(f);
  for (const f of cfg.columns ?? []) sliceFields.add(f);

  const filterSelections: Record<string, string[]> = {};
  if (pivot.filterSelections) {
    for (const [field, values] of Object.entries(pivot.filterSelections)) {
      if (Array.isArray(values) && values.length > 0) {
        filterSelections[field] = values;
      }
    }
  }

  return {
    rowFields: cfg.rows ?? [],
    colFields: cfg.columns ?? [],
    filterFields: [...sliceFields],
    filterSelections:
      Object.keys(filterSelections).length > 0 ? filterSelections : undefined,
    valueSpecs: cfg.values,
    rowSort: cfg.rowSort,
  };
}

export function PivotTile({
  pivot,
  sessionId,
  canEdit = false,
  onDelete,
}: PivotTileProps) {
  const effectiveSessionId = sessionId ?? pivot.sourceSessionId ?? null;
  const queryRequest = useMemo(() => pivotConfigToQueryRequest(pivot), [pivot]);

  const [model, setModel] = useState<PivotModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!effectiveSessionId || !queryRequest) {
      setModel(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    pivotQuery(effectiveSessionId, queryRequest)
      .then((resp) => {
        if (cancelled) return;
        setModel(resp.model as unknown as PivotModel);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setModel(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveSessionId, queryRequest]);

  const flatRows = useMemo(() => {
    if (!model) return [];
    return flattenPivotTree(model.tree, new Set());
  }, [model]);

  return (
    <Card
      className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-background shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group"
      data-dashboard-tile="pivot"
      data-dashboard-pivot-node
    >
      <CardHeader className="flex w-full items-center justify-between pb-2 pt-3 px-4">
        <div className="flex items-center justify-between w-full gap-2">
          <CardTitle className="text-base text-foreground flex-1 min-w-0 truncate">
            {pivot.title}
          </CardTitle>
          {canEdit && onDelete && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                aria-label="Remove pivot from dashboard"
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4 min-h-0">
        {!effectiveSessionId && (
          <p className="text-sm text-muted-foreground">
            Pivot tile is missing its source session.
          </p>
        )}
        {effectiveSessionId && !queryRequest && (
          <p className="text-sm text-muted-foreground">
            Pivot config is incomplete.
          </p>
        )}
        {loading && <Skeleton className="h-full w-full" />}
        {error && !loading && (
          <p className="text-sm text-destructive">Couldn't load pivot: {error}</p>
        )}
        {model && !loading && !error && (
          <PivotGrid
            model={model}
            flatRows={flatRows}
            onToggleCollapse={() => {
              /* tile-level pivots don't support collapse for now */
            }}
            layout="expanded"
          />
        )}
      </CardContent>
    </Card>
  );
}
