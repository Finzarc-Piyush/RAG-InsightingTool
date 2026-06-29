/**
 * Wave WD3-sheet-fetch · row table for the drill-through sheet.
 *
 * Renders the response from the WD3-server endpoint as a compact HTML
 * `<table>` inside the Radix Sheet body. The sheet itself is narrow
 * (`sm:max-w-md` = 28rem), so the table sits inside an
 * `overflow-x-auto` wrapper for horizontal scrolling on wide rows.
 *
 * Pure render component. Owns no state. The caller passes the
 * server's response directly — no shape transformation.
 */

import type { DrillThroughResponse } from "../hooks/useDrillThroughRows";

interface DrillThroughRowTableProps {
  response: DrillThroughResponse;
}

/**
 * Stringify a raw row cell for table display. Matches the visual
 * weight of the sheet's other monospace fields:
 *   - null / undefined → "—" (em dash, lighter than the literal "null"
 *     used in the comparison path so users can see the absence)
 *   - Date → ISO
 *   - boolean / number → String
 *   - string → pass through
 */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  // No more than two decimals anywhere (W-DEC1): clamp non-integer numerics,
  // dropping trailing zeros (1234.5678 → "1234.57", 0.5 → "0.5").
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    return String(Number(value.toFixed(2)));
  }
  return String(value);
}

export function DrillThroughRowTable({ response }: DrillThroughRowTableProps) {
  const { rows, totalMatched, capApplied } = response;

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No rows match the drill request (the active filters may have
        excluded every row at the pin).
      </p>
    );
  }

  // Derive columns from the first row's keys. Real-world responses
  // are shape-uniform (every row has the same keys); a more defensive
  // implementation would union the keys but the server guarantees
  // uniformity from chart.data.
  const columns = Object.keys(rows[0] ?? {});

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {capApplied
          ? `Showing ${rows.length} of ${totalMatched} matching rows.`
          : `${rows.length} matching row${rows.length === 1 ? "" : "s"}.`}
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-xs font-mono">
          <thead className="bg-muted/40">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="border-b border-border px-2 py-1.5 text-left font-medium text-muted-foreground"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className={rowIdx % 2 === 0 ? "bg-background" : "bg-muted/20"}
              >
                {columns.map((col) => (
                  <td
                    key={col}
                    className="border-b border-border px-2 py-1 text-foreground"
                  >
                    {formatCell(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
