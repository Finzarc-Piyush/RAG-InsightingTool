import type { TemporalFacetColumnMeta } from "@/shared/schema";

/** Matches server `isTemporalFacetColumnKey`: legacy `__tf_*` or UI header `Month · …`. */
const DISPLAY_FACET_HEADER_RE = /^(Day|Week|Month|Quarter|Half-year|Year) · /;

export function isTemporalFacetFieldId(name: string): boolean {
  if (name.startsWith("__tf_")) return true;
  return DISPLAY_FACET_HEADER_RE.test(name);
}

const FACET_GRAIN_LABEL: Record<string, string> = {
  date: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  half_year: "Half-year",
  year: "Year",
};

const MONTH_SHORT_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function facetColumnHeaderLabel(meta: TemporalFacetColumnMeta): string {
  const g = FACET_GRAIN_LABEL[meta.grain] ?? meta.grain;
  return `${g} · ${meta.sourceColumn}`;
}

export function facetColumnHeaderLabelForColumn(
  columnName: string,
  temporalFacetColumns: TemporalFacetColumnMeta[] | undefined | null
): string {
  const list = temporalFacetColumns ?? [];
  const meta = list.find((m) => m.name === columnName);
  return meta ? facetColumnHeaderLabel(meta) : columnName;
}

/**
 * Format derived temporal facet bucket values produced by the backend (normalizedKey).
 * These values are categorical keys and must be rendered as temporal labels, not
 * locale-formatted numbers.
 */
export function formatTemporalFacetValue(
  value: unknown,
  grain: TemporalFacetColumnMeta["grain"]
): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  const yearOnly = s.match(/^\d{4}$/);
  if (grain === "year" && yearOnly) return yearOnly[0]!;

  // Server-normalized temporal facet keys:
  // - month:   YYYY-MM
  // - quarter: YYYY-Qn
  // - half_year: YYYY-Hn
  // - week:    YYYY-Www
  // - date:    YYYY-MM-DD
  switch (grain) {
    case "month": {
      const m = s.match(/^(\d{4})-(\d{2})$/);
      if (!m) return null;
      const year = Number(m[1]);
      const monthIdx = Number(m[2]) - 1;
      if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) return null;
      const yy = String(year).slice(-2);
      return `${MONTH_SHORT_NAMES[monthIdx]}-${yy}`;
    }
    case "quarter": {
      const q = s.match(/^(\d{4})-Q([1-4])$/);
      if (!q) return null;
      return `Q${q[2]} ${q[1]}`;
    }
    case "half_year": {
      const h = s.match(/^(\d{4})-H([12])$/);
      if (!h) return null;
      return `H${h[2]} ${h[1]}`;
    }
    case "week": {
      const w = s.match(/^(\d{4})-W(\d{1,2})$/);
      if (!w) return null;
      return `W${w[2]} ${w[1]}`;
    }
    case "date": {
      const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!d) return null;
      const year = Number(d[1]);
      const monthIdx = Number(d[2]) - 1;
      const day = Number(d[3]);
      if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11 || !Number.isFinite(day)) return null;
      const mon = MONTH_SHORT_NAMES[monthIdx];
      return `${String(day).padStart(2, "0")}-${mon}-${year}`;
    }
    case "year":
      return yearOnly ? yearOnly[0]! : null;
    default:
      return null;
  }
}

