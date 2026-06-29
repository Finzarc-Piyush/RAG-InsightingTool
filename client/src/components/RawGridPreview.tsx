// Correction UI for a wrong main-table detection. Shows the RAW top-left grid
// of the sheet (pre-header junk and all) and lets the user click the row that
// is the TRUE header. Confirming emits { headerRow } → the caller POSTs to
// /retable, which re-parses the original file with that override.

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { TableDetection } from '@/shared/schema';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detection: TableDetection;
  /** Called with the user-chosen 0-based header row index. */
  onConfirm: (headerRow: number) => void;
  isSubmitting?: boolean;
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

export function RawGridPreview({ open, onOpenChange, detection, onConfirm, isSubmitting }: Props) {
  const grid = detection.rawGridPreview ?? [];
  const [selected, setSelected] = useState<number>(detection.headerRowStart);
  const colCount = grid.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Pick the header row</DialogTitle>
          <DialogDescription>
            Click the row that holds your column names. Everything below it becomes the data; rows
            above are ignored. We&apos;ll re-read the file and regenerate the analysis.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] overflow-auto rounded border border-border text-xs">
          <table className="w-full border-collapse">
            <thead>
              <tr className="sticky top-0 bg-muted">
                <th className="w-10 border-b border-border px-2 py-1 text-left text-muted-foreground">#</th>
                {Array.from({ length: colCount }, (_, c) => (
                  <th
                    key={c}
                    className="border-b border-l border-border px-2 py-1 text-left font-mono text-muted-foreground"
                  >
                    {colLetter(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, r) => {
                const isSelected = r === selected;
                return (
                  <tr
                    key={r}
                    onClick={() => setSelected(r)}
                    className={`cursor-pointer ${
                      isSelected ? 'bg-primary/15 ring-1 ring-inset ring-primary/40' : 'hover:bg-muted/60'
                    }`}
                  >
                    <td className="border-b border-border px-2 py-1 text-muted-foreground">
                      {r + 1}
                      {isSelected ? ' ▸' : ''}
                    </td>
                    {Array.from({ length: colCount }, (_, c) => (
                      <td
                        key={c}
                        className="max-w-[160px] truncate border-b border-l border-border px-2 py-1"
                        title={row[c] ?? ''}
                      >
                        {row[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Header → row {selected + 1}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={() => onConfirm(selected)} disabled={isSubmitting}>
              {isSubmitting ? 'Re-reading…' : 'Use this row as header'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
