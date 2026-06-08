import { useCallback, useState } from 'react';
import { Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { TemporalFacetColumnMeta } from '@/shared/schema';
import {
  DataPreviewTable,
  type PivotBuilderAddPayload,
} from './DataPreviewTable';

/**
 * Wave PB · "Build pivot" composer affordance. Mirrors `ChartBuilderDialog`:
 * a self-contained trigger button that, when clicked, opens a BLANK pivot in
 * the same full-screen workspace used to expand a chat pivot — the user drags
 * fields into Rows / Columns / Values / Filters, builds a pivot over the full
 * dataset, then "Add to chat" appends it as an editable chat message.
 *
 * Implementation: it mounts a standalone `DataPreviewTable` in
 * `pivotBuilderMode` inside a hidden wrapper. That component renders its
 * pivot workspace via `createPortal(document.body)`, so the inline card stays
 * hidden while the full-screen box is visible. Mounting only while `open`
 * (with a fresh `key`) guarantees each launch starts blank.
 */
interface PivotBuilderLauncherProps {
  sessionId?: string | null;
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  sampleRows?: Record<string, any>[];
  onPivotAdded: (payload: PivotBuilderAddPayload) => void;
}

export function PivotBuilderLauncher({
  sessionId,
  columns,
  numericColumns = [],
  dateColumns = [],
  temporalFacetColumns = [],
  sampleRows,
  onPivotAdded,
}: PivotBuilderLauncherProps) {
  const [open, setOpen] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const disabled = !columns?.length || !sessionId;

  const handleOpen = useCallback(() => {
    setMountKey((k) => k + 1); // force a fresh, blank instance each launch
    setOpen(true);
  }, []);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleAdded = useCallback(
    (payload: PivotBuilderAddPayload) => {
      onPivotAdded(payload);
      setOpen(false);
    },
    [onPivotAdded],
  );

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 px-4 text-sm font-medium border-2 border-border bg-card hover:bg-muted/40 focus:ring-2 focus:ring-primary/40 focus:border-primary shadow-sm rounded-xl gap-2"
        onClick={handleOpen}
        disabled={disabled}
        title={disabled ? 'Upload data to build a pivot' : 'Build a pivot table'}
      >
        <Table2 className="w-4 h-4 text-muted-foreground" />
        <span>Build pivot</span>
      </Button>
      {open ? (
        <div className="hidden" aria-hidden>
          <DataPreviewTable
            key={mountKey}
            data={(sampleRows ?? []) as Record<string, any>[]}
            variant="analysis"
            pivotBuilderMode
            sessionId={sessionId}
            columns={columns}
            numericColumns={numericColumns}
            dateColumns={dateColumns}
            temporalFacetColumns={temporalFacetColumns}
            onPivotAdded={handleAdded}
            onCloseBuilder={handleClose}
          />
        </div>
      ) : null}
    </>
  );
}
