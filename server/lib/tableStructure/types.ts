// Table-structure detection — shared types.
//
// A detector inspects the RAW cell grid of a sheet (before it is collapsed to
// "row 1 = header") and returns the bounding region of the MAIN data table:
// which row(s) are the real header, where the data body lives, and which
// columns belong to it. Side/lookup tables and title/junk rows fall outside.
//
// All indices are 0-based GRID indices (grid[row][col]); the reader maps them
// back to 1-based ExcelJS rows/cols (or CSV matrix indices) when slicing.

export interface IgnoredBlock {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  reason: string;
}

export interface TableRegion {
  /** First header row (0-based grid row). */
  headerRowStart: number;
  /** Last header row, inclusive. Equals headerRowStart for a single-row header. */
  headerRowEnd: number;
  /** First data row. */
  dataRowStart: number;
  /** Last data row seen within the scan window, inclusive. ADVISORY — the
   * reader extends extraction to the real last non-empty row of the sheet
   * (the scan window is capped for performance). */
  dataRowEnd: number;
  /** Left column bound (0-based, inclusive). */
  colStart: number;
  /** Right column bound (0-based, inclusive). */
  colEnd: number;
  /** 0..1 — how confident the detector is in this region. */
  confidence: number;
  /** One-line human-readable explanation. */
  rationale: string;
  /** Where the region came from. */
  source: 'tier1' | 'tier2' | 'fallback' | 'override';
  /** True when header is row 0, a single full-width block, high confidence —
   * i.e. a normal clean sheet that needs no special handling and skips the LLM. */
  triviallyClean: boolean;
  /** Other table-like blocks deliberately excluded from the main table. */
  secondaryTablesIgnored: IgnoredBlock[];
}

/** A competing main-table candidate produced by Tier-1 scoring. */
export interface DetectionCandidate {
  headerRowStart: number;
  headerRowEnd: number;
  dataRowStart: number;
  dataRowEnd: number;
  colStart: number;
  colEnd: number;
  /** Size-weighted block score (used to pick the main table). */
  score: number;
  /** Raw header-likeness score of the chosen header row (0..1). */
  headerScore: number;
}

export interface DetectOptions {
  /** Cap on rows profiled by Tier-1 (perf guard). */
  maxScanRows?: number;
  /** Whether Tier-2 LLM adjudication is permitted. */
  llmEnabled?: boolean;
  /** Stable id forwarded to the LLM routing ramp. */
  turnId?: string;
  /** Sheet name — for the LLM rationale only. */
  sheetName?: string;
}
