// Independent data-summary table component extracted verbatim from
// DataPreviewTable.tsx (god-file decomposition, behaviour-preserving code
// motion). Self-contained, props-only; re-exported from the original
// DataPreviewTable.tsx path so existing `import { DataSummaryTable }` consumers
// (e.g. MessageBubble.tsx) keep working unchanged.
import { Card } from '@/components/ui/card';

interface DataSummaryTableProps {
  summary: Array<{
    variable: string;
    datatype: string;
    total_values: number;
    null_values: number;
    non_null_values: number;
    mean?: number | null;
    median?: number | null;
    std_dev?: number | null;
    min?: number | null;
    max?: number | null;
    mode?: any;
  }>;
}

export function DataSummaryTable({ summary }: DataSummaryTableProps) {
  if (!summary || summary.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No summary data available</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 mt-2">
      <h4 className="text-sm font-semibold mb-3 text-foreground">Data Summary</h4>
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto border border-border rounded-md">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-muted/40 z-10">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Variable</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Datatype</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">#Values</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">#Nulls</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Mean</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Median</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Mode</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">STD Dev</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row, idx) => (
              <tr
                key={idx}
                className="border-b border-border hover:bg-muted/30 transition-colors"
              >
                <td className="px-3 py-2 text-foreground font-medium">{row.variable}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.datatype}</td>
                <td className="px-3 py-2 text-foreground">{row.total_values}</td>
                <td className="px-3 py-2 text-foreground">{row.null_values}</td>
                <td className="px-3 py-2 text-foreground">
                  {row.mean !== null && row.mean !== undefined
                    ? typeof row.mean === 'number'
                      ? row.mean.toFixed(2)
                      : String(row.mean)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.median !== null && row.median !== undefined
                    ? typeof row.median === 'number'
                      ? row.median.toFixed(2)
                      : String(row.median)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.mode !== null && row.mode !== undefined
                    ? String(row.mode)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.std_dev !== null && row.std_dev !== undefined
                    ? typeof row.std_dev === 'number'
                      ? row.std_dev.toFixed(2)
                      : String(row.std_dev)
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
