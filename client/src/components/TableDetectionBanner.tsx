// Surfaced when the main-table detector found the real header/data bounds on a
// messy sheet (title rows, junk, a side table). Sits above `ColumnsDisplay`,
// mirroring `WideFormatBanner`. Reads from `dataSummary.tableDetection`
// (server-populated at upload, see the tableStructure detector).
//
// Non-blocking by design: ingest already completed using the auto-picked
// region. This banner just lets the user verify and, via "Adjust", correct it
// (which re-ingests + regenerates the analysis).

import { useState } from 'react';
import { ChevronDown, ChevronRight, TableProperties, AlertTriangle, Loader2 } from 'lucide-react';
import type { TableDetection } from '@/shared/schema';

interface Props {
  detection: TableDetection;
  /** Present ⇒ show the "Adjust" affordance. */
  onAdjust?: () => void;
  /** True while a retable round-trip is in flight. */
  isReingesting?: boolean;
}

/** 0 → "A", 26 → "AA". */
function colLetter(col0: number): string {
  let n = col0 + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function TableDetectionBanner({ detection, onAdjust, isReingesting }: Props) {
  const [open, setOpen] = useState(false);
  const lowConfidence = detection.confidence < 0.7;

  const skipped = detection.headerRowStart; // 0-based start ⇒ N rows above were skipped
  const sideCount = detection.secondaryTablesIgnored?.length ?? 0;

  const detailParts: string[] = [];
  if (skipped > 0) detailParts.push(`skipped ${skipped} title/junk row${skipped === 1 ? '' : 's'}`);
  if (sideCount > 0)
    detailParts.push(`ignored ${sideCount} side table${sideCount === 1 ? '' : 's'}`);
  if (lowConfidence) detailParts.push('low confidence — please verify');

  const tone = lowConfidence
    ? 'border-amber-500/40 bg-amber-500/5'
    : 'border-primary/20 bg-primary/5';
  const iconColor = lowConfidence ? 'text-amber-500' : 'text-primary';

  return (
    <div className={`mb-3 rounded-md border ${tone} px-3 py-2 text-sm`}>
      <div className="flex items-start gap-2">
        {lowConfidence ? (
          <AlertTriangle className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconColor}`} />
        ) : (
          <TableProperties className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconColor}`} />
        )}
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Detected the main table starting at row {detection.headerRowStart + 1}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {detailParts.length ? `${detailParts.join(' · ')}. ` : 'Header auto-detected. '}
            <button
              type="button"
              className="inline-flex items-center text-xs underline-offset-2 hover:underline text-foreground/80"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? (
                <ChevronDown className="mr-0.5 h-3 w-3" />
              ) : (
                <ChevronRight className="mr-0.5 h-3 w-3" />
              )}
              {open ? 'Hide' : 'View'} detection details
            </button>
            {onAdjust && (
              <>
                {' · '}
                <button
                  type="button"
                  disabled={isReingesting}
                  className="inline-flex items-center text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
                  onClick={onAdjust}
                >
                  {isReingesting ? (
                    <>
                      <Loader2 className="mr-0.5 h-3 w-3 animate-spin" /> Re-reading…
                    </>
                  ) : (
                    'Wrong? Adjust'
                  )}
                </button>
              </>
            )}
          </div>
          {open && (
            <div className="mt-2 max-h-40 overflow-auto rounded border border-border bg-card p-2 text-xs text-muted-foreground">
              <div>{detection.rationale}</div>
              {sideCount > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {detection.secondaryTablesIgnored.map((s, i) => (
                    <li key={i}>
                      Ignored columns {colLetter(s.colStart)}–{colLetter(s.colEnd)}
                      {s.reason ? ` (${s.reason})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
