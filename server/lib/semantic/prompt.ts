/**
 * Wave W59a · Semantic-layer prompt manifest.
 *
 * Pure deterministic function that renders a `SemanticModel` as a
 * byte-stable markdown block for inclusion in the planner prompt
 * (W59b), the admin UI (W61), and the narrator's metric-citation
 * block. Byte-stability is critical: prompt-cache hits (per
 * Anthropic's 2026 prompt-caching guidance) require the manifest to
 * render identically across two LLM calls whenever the underlying
 * model is unchanged. Every collection is sorted by `name` ascending
 * before emission and every entry uses a fixed line shape, so input
 * ordering and unexpected fields cannot perturb the output.
 *
 * Hidden entries (`exposed: false`) are skipped by default — the
 * planner should not see draft metrics. `includeHidden: true` is for
 * the admin UI which lists everything.
 *
 * Pure function. No I/O. No date dependencies. Safe in tests and any
 * runtime context.
 */

import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "../../shared/schema.js";

export interface FormatMetricCatalogOptions {
  /** Include `exposed: false` entries (admin UI). Default false. */
  includeHidden?: boolean;
  /** Emit per-section heading lines. Default true. Disable for compact preview. */
  includeSectionHeadings?: boolean;
}

const DEFAULT_OPTS: Required<FormatMetricCatalogOptions> = {
  includeHidden: false,
  includeSectionHeadings: true,
};

export function formatMetricCatalog(
  model: SemanticModel,
  opts: FormatMetricCatalogOptions = {},
): string {
  const o = { ...DEFAULT_OPTS, ...opts };
  const metrics = visibleMetrics(model, o);
  const dimensions = visibleDimensions(model, o);
  const hierarchies = sortedHierarchies(model);

  if (
    metrics.length === 0 &&
    dimensions.length === 0 &&
    hierarchies.length === 0
  ) {
    return [
      `## Semantic catalog (v${model.version})`,
      ``,
      `_(empty — no metrics, dimensions, or hierarchies declared; fall back to raw \`execute_query_plan\` against the dataset schema)_`,
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`## Semantic catalog (v${model.version} — ${model.name})`);
  lines.push("");
  lines.push(
    "Prefer `execute_metric_query` when the question maps to one of these metrics; fall back to `execute_query_plan` only when no metric matches.",
  );
  lines.push("");

  if (o.includeSectionHeadings) {
    lines.push(`### Metrics (${metrics.length})`);
    lines.push("");
  }
  if (metrics.length === 0) {
    lines.push("_(none)_");
    lines.push("");
  } else {
    for (const m of metrics) lines.push(...formatMetricLines(m));
  }

  if (o.includeSectionHeadings) {
    lines.push(`### Dimensions (${dimensions.length})`);
    lines.push("");
  }
  if (dimensions.length === 0) {
    lines.push("_(none)_");
    lines.push("");
  } else {
    for (const d of dimensions) lines.push(...formatDimensionLines(d));
  }

  if (o.includeSectionHeadings) {
    lines.push(`### Hierarchies (${hierarchies.length})`);
    lines.push("");
  }
  if (hierarchies.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const h of hierarchies) lines.push(...formatHierarchyLines(h));
  }

  return lines.join("\n").replace(/\s+$/, "");
}

export function formatMetricLines(m: SemanticMetric): string[] {
  const lines: string[] = [`- \`${m.name}\` — ${m.label}`];
  lines.push(`  - Expression: \`${m.expression}\``);
  lines.push(`  - Format: ${formatHint(m)}`);
  if (m.references.length > 0) {
    lines.push(`  - References: ${m.references.join(", ")}`);
  }
  if (m.description) {
    lines.push(`  - ${oneLine(m.description)}`);
  }
  lines.push("");
  return lines;
}

export function formatDimensionLines(d: SemanticDimension): string[] {
  const lines: string[] = [`- \`${d.name}\` — ${d.label}`];
  lines.push(`  - Column: \`${d.column}\``);
  let kindLine = `  - Kind: ${d.kind}`;
  if (d.kind === "temporal" && d.temporalGrain) {
    kindLine += ` (${d.temporalGrain})`;
  }
  lines.push(kindLine);
  if (d.description) {
    lines.push(`  - ${oneLine(d.description)}`);
  }
  lines.push("");
  return lines;
}

export function formatHierarchyLines(h: SemanticHierarchy): string[] {
  const lines: string[] = [`- \`${h.name}\` — ${h.label}`];
  lines.push(`  - Levels: ${h.levels.join(" → ")}`);
  if (h.description) {
    lines.push(`  - ${oneLine(h.description)}`);
  }
  lines.push("");
  return lines;
}

function formatHint(m: SemanticMetric): string {
  const parts: string[] = [m.format];
  if (m.format === "currency" && m.currencyCode) {
    parts[0] = `currency (${m.currencyCode})`;
  }
  if (m.decimals !== undefined) {
    parts.push(`${m.decimals} dp`);
  }
  return parts.join(", ");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function visibleMetrics(
  model: SemanticModel,
  opts: Required<FormatMetricCatalogOptions>,
): SemanticMetric[] {
  return [...model.metrics]
    .filter((m) => opts.includeHidden || m.exposed)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function visibleDimensions(
  model: SemanticModel,
  opts: Required<FormatMetricCatalogOptions>,
): SemanticDimension[] {
  return [...model.dimensions]
    .filter((d) => opts.includeHidden || d.exposed)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sortedHierarchies(model: SemanticModel): SemanticHierarchy[] {
  return [...model.hierarchies].sort((a, b) => a.name.localeCompare(b.name));
}
