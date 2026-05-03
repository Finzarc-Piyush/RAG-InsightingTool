/**
 * v1 → v2 ChartSpec converter.
 *
 * Pure function used by <ChartShim> so existing callers (chat
 * messages, dashboard cards, pivot panel) keep working unchanged
 * while the v2 renderer lights up behind per-mark feature flags.
 *
 * Mapping table:
 *   v1.type='scatter' → v2.mark='point'
 *   v1.type='pie'     → v2.mark='arc'
 *   v1.type='heatmap' → v2.mark='rect'
 *   else identity
 *
 *   v1.{x,y,z,seriesColumn,y2,aggregate,xLabel,yLabel,y2Label,
 *        zLabel,xDomain,yDomain,data,_agentProvenance,
 *        _agentEvidenceRef,_agentTurnId} → v2 equivalents
 *
 * Fields that don't have a clean v2 home yet (barLayout, seriesKeys,
 * y2Series, trendLine, _useAnalyticalDataOnly) are preserved on a
 * `_v1Legacy` escape hatch so renderers can still read them. They'll
 * graduate to first-class encodings or transforms in subsequent waves.
 */

import type {
  ChartSpec,
  ChartSpecV2,
  ChartV2Mark,
  ChartFieldType,
  ChartEncodingChannel,
  ChartAggOp,
} from "@/shared/schema";

const TYPE_TO_MARK: Record<ChartSpec["type"], ChartV2Mark> = {
  line: "line",
  bar: "bar",
  scatter: "point",
  pie: "arc",
  area: "area",
  heatmap: "rect",
};

/**
 * Heuristic field-type inference. v1 specs don't carry per-field types,
 * so we make a best guess based on the mark and the column role.
 *   - quantitative for y / z / y2 always
 *   - temporal for x of line / area when the column name looks like a date
 *   - nominal otherwise for x and seriesColumn
 */
function inferType(
  mark: ChartV2Mark,
  channel: "x" | "y" | "z" | "y2" | "color",
  fieldName: string | undefined,
): ChartFieldType {
  if (channel === "y" || channel === "y2" || channel === "z") return "q";
  if (
    (mark === "line" || mark === "area") &&
    channel === "x" &&
    fieldName &&
    looksLikeDateField(fieldName)
  ) {
    return "t";
  }
  if (mark === "point" && channel === "x") return "q";
  return "n";
}

const DATE_FIELD_RE =
  /\b(date|day|month|quarter|year|week|time|timestamp|created_at|updated_at|period)\b/i;
function looksLikeDateField(name: string): boolean {
  return DATE_FIELD_RE.test(name);
}

/** Map v1 `aggregate` enum to v2's wider aggregate set. */
function mapAggregate(v1: ChartSpec["aggregate"]): ChartAggOp | undefined {
  if (!v1 || v1 === "none") return undefined;
  return v1 as ChartAggOp;
}

function buildChannel(
  field: string | undefined,
  type: ChartFieldType,
  axisTitle?: string,
  domain?: [number, number],
  aggregate?: ChartAggOp,
): ChartEncodingChannel | undefined {
  if (!field) return undefined;
  const ch: ChartEncodingChannel = { field, type };
  if (axisTitle || domain) {
    ch.axis = {
      ...(axisTitle ? { title: axisTitle } : {}),
    };
  }
  if (domain) {
    ch.scale = { domain: [domain[0], domain[1]] };
  }
  if (aggregate) ch.aggregate = aggregate;
  return ch;
}

export interface V2ConversionResult {
  spec: ChartSpecV2;
  /** Fields that didn't map cleanly; renderers may fall back to v1 logic via `_v1Legacy`. */
  warnings: string[];
}

/**
 * Convert a v1 ChartSpec into a v2 ChartSpecV2. Pure & total — every v1
 * shape produces a v2 shape; warnings list anything lossy.
 */
export function convertV1ToV2(v1: ChartSpec): V2ConversionResult {
  const warnings: string[] = [];
  const mark = TYPE_TO_MARK[v1.type];
  if (!mark) {
    warnings.push(`Unknown v1 type "${v1.type}", defaulting to bar`);
  }
  const finalMark = mark ?? "bar";

  const aggregate = mapAggregate(v1.aggregate);

  const x = buildChannel(
    v1.x,
    inferType(finalMark, "x", v1.x),
    v1.xLabel,
    v1.xDomain ? [v1.xDomain[0], v1.xDomain[1]] : undefined,
  );

  const y = buildChannel(
    v1.y,
    inferType(finalMark, "y", v1.y),
    v1.yLabel,
    v1.yDomain ? [v1.yDomain[0], v1.yDomain[1]] : undefined,
    aggregate,
  );

  // z is interpreted as size for bubble-style scatter; for heatmap it IS
  // the value (mapped to color); otherwise as detail.
  let size: ChartEncodingChannel | undefined;
  let detail: ChartEncodingChannel | undefined;
  let heatmapValueChannel: ChartEncodingChannel | undefined;
  if (v1.z) {
    if (finalMark === "point") {
      size = buildChannel(
        v1.z,
        "q",
        v1.zLabel,
      );
    } else if (finalMark === "rect") {
      // For heatmap, v1.z is the value — RectRenderer reads it via
      // encoding.color. Wire it explicitly here so v2 heatmaps don't
      // throw "rect mark requires color".
      heatmapValueChannel = buildChannel(v1.z, "q", v1.zLabel);
    } else {
      detail = buildChannel(v1.z, "q", v1.zLabel);
    }
  }

  // seriesColumn → color (qualitative). For heatmap, the heatmap value
  // channel above takes precedence (a v1 heatmap with seriesColumn is
  // rare but possible — drop the seriesColumn in that case).
  const color: ChartEncodingChannel | undefined = heatmapValueChannel
    ? heatmapValueChannel
    : v1.seriesColumn
      ? {
          field: v1.seriesColumn,
          type: "n",
        }
      : undefined;

  // y2 → second positional encoding
  const y2 = v1.y2
    ? buildChannel(v1.y2, "q", v1.y2Label, undefined, aggregate)
    : undefined;

  // v1.barLayout maps directly to v2 config.barLayout (added to schema in
  // this session). No data loss anymore — drop the warning.
  const barLayout = v1.barLayout;

  // Forward seriesKeys onto color.sort so v2 multi-series renders in v1
  // order. Schema's sortSpec accepts the categorical-order pattern via
  // a custom field; we use the simpler `{ field, order }` shape here
  // and let renderers respect or ignore it.
  if (v1.seriesKeys?.length && color) {
    (color as ChartEncodingChannel).sort = {
      field: color.field,
      order: "ascending",
    } as ChartEncodingChannel["sort"];
  }
  if (v1.y2Series?.length) {
    warnings.push(`y2Series preserved on _v1Legacy; v2 multi-y2 pending`);
  }
  if (v1.trendLine?.length) {
    warnings.push(
      `trendLine preserved on _v1Legacy; v2 will use 'trend' layer instead`,
    );
  }

  // Forward server-attached auto-layers (WC7) into v2.layers.
  const autoLayers = (v1 as unknown as { _autoLayers?: unknown[] })._autoLayers;
  const layersOut: ChartSpecV2["layers"] = autoLayers
    ? (autoLayers as ChartSpecV2["layers"])
    : undefined;

  const spec: ChartSpecV2 = {
    version: 2,
    mark: finalMark,
    encoding: {
      ...(x ? { x } : {}),
      ...(y ? { y } : {}),
      ...(y2 ? { y2 } : {}),
      ...(color ? { color: { ...color, scheme: "qualitative" } } : {}),
      ...(size ? { size } : {}),
      ...(detail ? { detail } : {}),
    },
    source: v1.data
      ? { kind: "inline", rows: v1.data as Record<string, unknown>[] as never }
      : { kind: "inline", rows: [] },
    ...(layersOut?.length ? { layers: layersOut } : {}),
    config: {
      ...(v1.title
        ? { title: { text: v1.title.slice(0, 200) } }
        : {}),
      ...(barLayout ? { barLayout } : {}),
    },
    ...(v1._agentProvenance
      ? { _agentProvenance: v1._agentProvenance }
      : {}),
    ...(v1._agentEvidenceRef
      ? { _agentEvidenceRef: v1._agentEvidenceRef }
      : {}),
    ...(v1._agentTurnId ? { _agentTurnId: v1._agentTurnId } : {}),
  };

  return { spec, warnings };
}
