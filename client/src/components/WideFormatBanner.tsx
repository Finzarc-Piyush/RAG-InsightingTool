// Surfaced when the upload pipeline detected a wide-format dataset
// and reshaped it to long form. Sits above `ColumnsDisplay`.
//
// Reads from `dataSummary.wideFormatTransform` (server-populated at
// upload time, see WF7). Collapsible "View original wide-format
// columns" lists the headers that were melted into Period × Value.

import { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { ColumnCurrency, WideFormatTransform } from '@/shared/schema';

interface Props {
  transform: WideFormatTransform;
  /** Currency tag of the new long-format Value column, surfaced in
   * the headline. Optional — when missing, banner just says "Value". */
  valueCurrency?: ColumnCurrency;
}

export function WideFormatBanner({ transform, valueCurrency }: Props) {
  const [open, setOpen] = useState(false);
  const valueLabel = valueCurrency?.isoCode
    ? `${transform.valueColumn} (${valueCurrency.isoCode})`
    : transform.valueColumn;
  const shapeLabel =
    transform.shape === 'compound'
      ? `${transform.periodColumn} × ${transform.metricColumn ?? 'Metric'} × ${valueLabel}`
      : `${transform.periodColumn} × ${valueLabel}`;

  return (
    <div className="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
        <div className="flex-1">
          <div className="font-medium text-foreground">
            Auto-transformed wide-format data
          </div>
          <div className="mt-0.5 text-muted-foreground">
            {transform.periodCount} period column{transform.periodCount === 1 ? '' : 's'} reshaped to{' '}
            <span className="font-mono text-foreground">{shapeLabel}</span> rows.{' '}
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
              {open ? 'Hide' : 'View'} original wide-format columns
            </button>
          </div>
          {open && (
            <div className="mt-2 max-h-40 overflow-auto rounded border border-border bg-card p-2 font-mono text-xs text-muted-foreground">
              {transform.meltedColumns.map((c, i) => (
                <div key={i}>{c}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
