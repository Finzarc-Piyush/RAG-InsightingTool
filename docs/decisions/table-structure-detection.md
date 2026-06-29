# ADR: Main-table detection for casually-authored spreadsheets

**Status:** Accepted · `TABLE_STRUCTURE_DETECT_ENABLED` (default ON; set in `server.env`). A user table-region override is honored even if it were disabled.

## Context

Ingest assumed the data table starts at row 1 — `readExcelObjectRows` hardcoded
`ws.getRow(1)` as the header and `buildHeaderKeys` named empty header cells
`__EMPTY_n`. Real workbooks from non-power-users break this: a title row in A1,
the real header in row 2, a gap-separated side/lookup table, junk/merged cells,
or multi-row headers. The whole downstream (data summary, column panel, suggested
questions) then faithfully described garbage. There is no fixed shape to match —
the variations are open-ended — so the solution must *reason* about structure, not
pattern-match a layout.

## Decision

A two-tier detector in `server/lib/tableStructure/` runs over the RAW cell grid
*before* the reader collapses it to "row 1 = header":

1. **Tier-1 (deterministic, always runs, free):** profile per-row/-col density,
   type and distinctness; split the sheet into gap-separated column blocks
   (isolating side tables); score each candidate header row (dense + text/label
   dominant + distinct + the body below is type-stable, minus a numeric-row
   penalty and a big penalty for a merged title spanning the block). Reuses the
   existing `wideFormat/` vocabulary (`tagColumn`/`classifyDataset`) for the
   "does this row look like column labels?" signal. Emits a region + confidence +
   a `triviallyClean` flag.
2. **Tier-2 (LLM, on every *non-trivial* sheet):** a MINI-tier model
   (`LLM_PURPOSE.TABLE_STRUCTURE_DETECT`) adjudicates from a compact corner map
   (≤25 rows × ≤30 cols) + the Tier-1 candidates. Output is Zod-validated and
   clamped to grid bounds; any failure falls back to Tier-1, so Tier-2 is never
   worse than Tier-1. A trivially-clean sheet skips the LLM entirely and is
   byte-identical to the legacy path.

**Non-blocking, mirrors wide-format auto-melt — NOT the `SHEET_SELECTION_REQUIRED`
block.** The detector auto-picks its best region and ingest proceeds immediately.
The result rides `dataSummary.tableDetection` to the client, which shows a
`TableDetectionBanner` (suppressed for clean sheets). Correction is post-hoc: the
user clicks the true header row in a raw-grid preview → `POST /sessions/:id/retable`
re-parses the original blob bytes with the override and regenerates the analysis —
the sanctioned "user input triggers regeneration, never blocks startup" shape.

## Consequences

- Default ON (clean sheets are byte-identical; only casually-authored sheets change). `=false` in env would disable it, but the product intent is always-on.
- A user `tableRegionOverride` is honored regardless of the flag.
- The LLM only ever sees the top-left corner — cost is constant regardless of row count.
- Follow-ups (not built): v2 drag-select rectangle picker, multi-table picker,
  totals-row tagging, capturing the override in automation recipe replay.
