/**
 * Metadata Service
 * Computes and caches dataset metadata (row count, column types, null %, cardinality)
 */

import { ColumnarStorageService, DatasetMetadata } from './columnarStorage.js';
import { DataSummary } from '../shared/schema.js';
import { inferTemporalGrainFromDates } from './temporalGrain.js';
import { deriveDateRangeFromRows } from './temporalGrainAuthority.js';
import { isLikelyIdentifierColumnName } from './columnIdHeuristics.js';
import {
  isTemporalFacetColumnKey,
  temporalFacetMetadataForDateColumns,
} from './temporalFacetColumns.js';

export interface CachedMetadata {
  metadata: DatasetMetadata;
  summary: DataSummary;
  computedAt: number;
  sessionId: string;
}

export class MetadataService {
  private cache: Map<string, CachedMetadata> = new Map();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Compute metadata for a dataset
   */
  async computeMetadata(
    storage: ColumnarStorageService,
    tableName: string = 'data'
  ): Promise<DatasetMetadata> {
    return await storage.computeMetadata(tableName);
  }

  /**
   * Convert DuckDB metadata to DataSummary format
   */
  convertToDataSummary(metadata: DatasetMetadata, sampleRows: Record<string, any>[]): DataSummary {
    const numericColumns: string[] = [];
    const dateColumns: string[] = [];

    const columns = metadata.columns.map((col) => {
      // Determine type based on DuckDB type and metadata
      let type = 'string';
      
      if (col.type && (
        col.type.includes('DOUBLE') ||
        col.type.includes('INTEGER') ||
        col.type.includes('BIGINT') ||
        col.type.includes('DECIMAL') ||
        col.type.includes('FLOAT')
      )) {
        type = 'number';
        numericColumns.push(col.name);
      } else if (
        col.type &&
        // Never classify one of our own derived facet columns as a date source.
        // read_csv_auto re-types "Day · Date" as DATE on a re-uploaded enriched
        // file; treating it as a date would nest it into "Day · Day · Date".
        !isTemporalFacetColumnKey(col.name) &&
        // Never classify a composite/identifier key (e.g. "TSOE-Date Combo") as a
        // date — mirrors the in-memory createDataSummary gate so the two ingest
        // paths agree.
        !isLikelyIdentifierColumnName(col.name) &&
        (/\bDATE\b/i.test(col.type) ||
          /\bTIMESTAMP\b/i.test(col.type) ||
          /\bDATETIME\b/i.test(col.type) ||
          /^TIME\b/i.test(col.type.trim()))
      ) {
        type = 'date';
        dateColumns.push(col.name);
      }

      // Get sample values from sampleRows
      const sampleValues = sampleRows
        .slice(0, 3)
        .map(row => row[col.name])
        .filter(v => v !== null && v !== undefined);

      let temporalDisplayGrain: 'dayOrWeek' | 'monthOrQuarter' | 'year' | undefined;
      if (type === 'date' && sampleRows.length > 0) {
        const parsedDates = sampleRows
          .map((row) => row[col.name])
          .filter((v): v is Date => v instanceof Date && !isNaN(v.getTime()));
        if (parsedDates.length > 0) {
          temporalDisplayGrain = inferTemporalGrainFromDates(parsedDates);
        }
      }

      // Backfill per-column dateRange (span metadata) from the sample rows. The
      // in-memory `createDataSummary` path computes this over the full dataset;
      // this columnar/reload path used to omit it entirely, which silently forced
      // every span-aware grain decision to Month-first (the single-month-daily
      // bug). Sample-derived span is sufficient for the grain thresholds; the
      // grain authority also re-derives from the charted rows as a final fallback.
      const dateRange =
        type === 'date' ? deriveDateRangeFromRows(sampleRows, col.name) : undefined;

      return {
        name: col.name,
        type,
        sampleValues,
        ...(temporalDisplayGrain !== undefined ? { temporalDisplayGrain } : {}),
        ...(dateRange ? { dateRange } : {}),
      };
    });

    const temporalFacetColumns = temporalFacetMetadataForDateColumns(dateColumns);

    // Merge the derived temporal facet columns ("Day · Date", "Month · Date", …)
    // INTO `columns` so the single grain authority (`resolveTrendGrain`) can
    // ENUMERATE them as candidate time axes. The in-memory `createDataSummary`
    // path already does this (fileParser.ts:856-859); this columnar/metadata-reload
    // path historically put facets ONLY in `temporalFacetColumns`, so the authority
    // — which enumerates candidates solely from `summary.columns` — never saw a
    // daily candidate, and a single month of daily data collapsed to one Month dot.
    //
    // Added UNCONDITIONALLY (not gated on materialized sample values like the
    // in-memory path): on the columnar table the facets are VIRTUAL — computed
    // inline from the source date column at query/render time
    // (`facetColumnInlineDuckDbExpr`) — so they are always "available" even when the
    // sampled rows carry no materialized facet values. Skip any whose name is
    // already a physical column (a re-uploaded enriched file re-types "Day · Date").
    const existingNames = new Set(columns.map((c) => c.name));
    const facetColumnInfos = temporalFacetColumns
      .filter((m) => !existingNames.has(m.name))
      .map((m) => ({
        name: m.name,
        type: 'string' as const,
        sampleValues: sampleRows
          .slice(0, 3)
          .map((row) => row[m.name])
          .filter((v) => v !== null && v !== undefined),
        temporalFacetGrain: m.grain,
        temporalFacetSource: m.sourceColumn,
      }));
    const allColumns = [...columns, ...facetColumnInfos];

    return {
      rowCount: metadata.rowCount,
      // Keep columnCount === columns.length (the in-memory path and
      // computedColumns.ts:323 both hold this); now that facets are listed they count.
      columnCount: allColumns.length,
      columns: allColumns,
      numericColumns,
      dateColumns,
      temporalFacetColumns,
    };
  }

  /**
   * Cache metadata for a session
   */
  cacheMetadata(sessionId: string, metadata: DatasetMetadata, summary: DataSummary): void {
    this.cache.set(sessionId, {
      metadata,
      summary,
      computedAt: Date.now(),
      sessionId,
    });
  }

  /**
   * Get cached metadata
   */
  getCachedMetadata(sessionId: string): CachedMetadata | null {
    const cached = this.cache.get(sessionId);
    if (!cached) {
      return null;
    }

    // Check if cache is expired
    if (Date.now() - cached.computedAt > this.CACHE_TTL) {
      this.cache.delete(sessionId);
      return null;
    }

    return cached;
  }

  /**
   * Invalidate cache for a session
   */
  invalidateCache(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Clear all expired cache entries
   */
  cleanupExpiredCache(): void {
    const now = Date.now();
    for (const [sessionId, cached] of this.cache.entries()) {
      if (now - cached.computedAt > this.CACHE_TTL) {
        this.cache.delete(sessionId);
      }
    }
  }
}

// Singleton instance
export const metadataService = new MetadataService();

// Cleanup expired cache every hour
const interval = setInterval(() => {
  metadataService.cleanupExpiredCache();
}, 60 * 60 * 1000);
// Allow Node process (and test runner) to exit even if the interval is still pending.
interval.unref?.();

