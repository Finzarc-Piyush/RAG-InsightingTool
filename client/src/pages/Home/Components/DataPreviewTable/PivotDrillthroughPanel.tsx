// Props-only presentational drillthrough-results panel extracted verbatim from
// DataPreviewTable.tsx (god-file decomposition, behaviour-preserving code
// motion). It renders the raw rows returned by a pivot-cell drillthrough; the
// close affordance is delegated to the `onClose` prop (formerly an inline
// `setDrillthrough(null)`). No component state is captured — render output is
// identical to the former inline block.

export interface DrillthroughState {
  loading: boolean;
  error: string | null;
  count: number | null;
  rows: Record<string, unknown>[];
}

export function PivotDrillthroughPanel({
  drillthrough,
  onClose,
}: {
  drillthrough: DrillthroughState | null;
  onClose: () => void;
}) {
  if (!drillthrough) return null;
  return (
    <div className="mt-3 rounded-lg border border-border/60 bg-background/70 p-3 shrink-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <div className="text-xs text-muted-foreground">Drillthrough rows</div>
          <div className="text-sm font-semibold">
            {drillthrough.loading ? 'Loading...' : `${drillthrough.count ?? 0} rows`}
          </div>
          {drillthrough.error && (
            <div className="text-xs text-destructive mt-1">{drillthrough.error}</div>
          )}
        </div>
        <button
          type="button"
          className="text-xs rounded border border-border/60 px-2 py-1 hover:bg-muted"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      {drillthrough.loading ? null : (
        <div className="overflow-x-auto max-h-[260px]">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-muted/30 z-10">
              <tr>
                {drillthrough.rows[0]
                  ? Object.keys(drillthrough.rows[0]!).map((c) => (
                      <th
                        key={c}
                        className="text-left px-2 py-1 border-b border-border/60 whitespace-nowrap"
                      >
                        {c}
                      </th>
                    ))
                  : null}
              </tr>
            </thead>
            <tbody>
              {drillthrough.rows.slice(0, 50).map((r, idx) => (
                <tr key={idx} className="border-b border-border/40">
                  {drillthrough.rows[0]
                    ? Object.keys(drillthrough.rows[0]!).map((c) => (
                        <td key={c} className="px-2 py-1 whitespace-nowrap">
                          {String((r as any)[c] ?? '')}
                        </td>
                      ))
                    : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
