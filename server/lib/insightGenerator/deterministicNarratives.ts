import type { ChartSpec } from "../../shared/schema.js";
import type { PivotPatterns } from "./pivotPatterns.js";

const fmtPct = (v: number, digits = 0): string =>
  Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : "N/A";
const fmtMul = (v: number, digits = 1): string =>
  Number.isFinite(v) ? `${v.toFixed(digits)}×` : "N/A";

export type DeterministicFallbackFamily =
  | "trend"
  | "concentration"
  | "dispersion"
  | "relationship"
  | "diagnostic";

export function selectFallbackFamily(p: PivotPatterns): DeterministicFallbackFamily {
  if (
    p.isTemporal &&
    (p.trendDirection === "up" ||
      p.trendDirection === "down" ||
      (p.recentVsPriorDelta !== undefined && Math.abs(p.recentVsPriorDelta) >= 0.05))
  ) {
    return "trend";
  }
  if ((p.hhi !== undefined && p.hhi > 0.25) || (p.top1Share !== undefined && p.top1Share > 0.4)) {
    return "concentration";
  }
  if (p.cv !== undefined && p.cv > 0.3) {
    return "dispersion";
  }
  if (p.dualAxis && p.yY2Strength === "strong") {
    return "relationship";
  }
  return "diagnostic";
}

type Args = {
  patterns: PivotPatterns;
  chartSpec: Pick<ChartSpec, "x" | "y" | "seriesColumn" | "seriesKeys">;
  dimensionLabel: string;
  formatY: (n: number) => string;
};

/**
 * Each narrative family is internally a 4-claim structure:
 *   headline → driver → risk → nextCheck.
 * The text fallback joins them with spaces; the envelope fallback maps them
 * to {findings, implications, recommendations} for the pivot view.
 */
export type FourClaim = {
  headline: string;
  driver: string;
  risk: string;
  nextCheck: string;
};

const namedSegments = (labels: string[], max = 3): string => {
  const filtered = labels.filter(Boolean);
  if (filtered.length === 0) return "";
  return filtered.slice(0, max).join(", ");
};

function trendNarrative({ patterns: p, chartSpec, formatY }: Args): FourClaim {
  const direction =
    p.trendDirection === "up"
      ? "rising"
      : p.trendDirection === "down"
      ? "declining"
      : p.trendDirection === "flat"
      ? "flat"
      : "mixed";
  const deltaPct =
    p.recentVsPriorDelta !== undefined && Number.isFinite(p.recentVsPriorDelta)
      ? `${p.recentVsPriorDelta >= 0 ? "+" : ""}${(p.recentVsPriorDelta * 100).toFixed(1)}%`
      : null;

  const peak = p.peakLabel;
  const trough = p.troughLabel;
  const top = p.topPerformers[0];
  const bot = p.bottomPerformers[0];

  const headline = deltaPct
    ? `${chartSpec.y} is ${direction} — the most recent periods are ${deltaPct} compared with the prior window${peak && trough ? `, with the high point at ${peak} (${formatY(top!.y)}) and the low point at ${trough} (${formatY(bot!.y)})` : ""}.`
    : `${chartSpec.y} shows a ${direction} pattern${peak && trough ? `, peaking at ${peak} (${formatY(top!.y)}) and bottoming at ${trough} (${formatY(bot!.y)})` : ""}.`;

  const driver =
    p.cv !== undefined && p.cv > 0.3
      ? `Period-to-period swings are large, so a single-period read can mislead.`
      : `Period-to-period swings are moderate, so directional reads are reliable.`;

  const risk =
    direction === "declining"
      ? `If the recent rate continues, ${chartSpec.y} is on a path worth flagging for the next planning cycle, particularly if ${trough ?? "the low point"} reflects something structural rather than a seasonal dip.`
      : direction === "rising"
      ? `The recent momentum is favourable, but it is worth checking whether the lift is broad-based or carried by a single slice before assuming it continues.`
      : `A flat or mixed trajectory means averaging across the window can hide segments that are actually moving in opposite directions.`;

  const nextCheck =
    peak && trough && chartSpec.seriesColumn
      ? `Next: compare ${peak} vs ${trough} broken down by ${chartSpec.seriesColumn} to see whether the swing is concentrated in one slice or broad-based.`
      : peak && trough
      ? `Next: compare ${peak} vs ${trough} broken down by another available dimension to see whether the swing is concentrated in one slice or broad-based.`
      : chartSpec.seriesColumn
      ? `Next: split the window by ${chartSpec.seriesColumn} to see whether the trajectory is broad-based or driven by one slice.`
      : `Next: split the window by another available dimension to see whether the trajectory is broad-based or driven by one slice.`;

  return { headline, driver, risk, nextCheck };
}

function concentrationNarrative({ patterns: p, chartSpec, dimensionLabel, formatY }: Args): FourClaim {
  const top = p.topPerformers[0];
  const top3 = p.topPerformers.slice(0, 3);
  const top3Labels = namedSegments(top3.map((t) => String(t.x)));
  const top1ShareStr = p.top1Share !== undefined ? fmtPct(p.top1Share) : "N/A";
  const top3ShareStr = p.top3Share !== undefined ? fmtPct(p.top3Share) : "N/A";
  const leaderMul =
    p.leaderVsMedianMultiple !== undefined && Number.isFinite(p.leaderVsMedianMultiple)
      ? p.leaderVsMedianMultiple
      : null;
  const leaderText =
    leaderMul !== null
      ? leaderMul >= 1.5
        ? `, almost ${fmtMul(leaderMul)} the typical ${dimensionLabel}`
        : leaderMul >= 1.2
        ? `, ${fmtMul(leaderMul)} the typical ${dimensionLabel}`
        : ""
      : "";

  const headline = top
    ? `${chartSpec.y} is concentrated — ${dimensionLabel} "${top.x}" alone holds ${top1ShareStr} of the total at ${formatY(top.y)}${leaderText}.`
    : `${chartSpec.y} is concentrated.`;

  const tailCount = p.longTailCount ?? 0;
  const tailShare = p.longTailShare !== undefined ? fmtPct(p.longTailShare) : "N/A";
  const driver = top3
    ? `The top three ${dimensionLabel}s — ${top3Labels} — account for ${top3ShareStr} together${tailCount > 0 ? `; the remaining ${tailCount} smaller ${dimensionLabel}${tailCount === 1 ? "" : "s"} contribute only ${tailShare}` : ""}.`
    : "";

  const risk = `Because so much depends on "${top?.x ?? "the leader"}", any swing there moves the headline number. Spreading effort thinly across the smaller segments is unlikely to close the gap.`;

  const nextCheck = top && chartSpec.seriesColumn
    ? `Next: break "${top.x}" down by ${chartSpec.seriesColumn} to see whether its lead is broad-based or driven by one part of the mix, and look at "${top.x}" alone over time to confirm it is a stable anchor.`
    : top
    ? `Next: break "${top.x}" down by another available dimension to see whether its lead is broad-based or driven by one part of the mix, and look at "${top.x}" alone over time to confirm it is a stable anchor.`
    : `Next: break the leading ${dimensionLabel} down by another available dimension to see whether the lead is broad-based or driven by one part of the mix.`;

  return { headline, driver, risk, nextCheck };
}

function dispersionNarrative({ patterns: p, chartSpec, dimensionLabel, formatY }: Args): FourClaim {
  const top = p.topPerformers[0];
  const bot = p.bottomPerformers[0];
  const ratio =
    p.topToBottomRatio !== undefined && Number.isFinite(p.topToBottomRatio)
      ? fmtMul(p.topToBottomRatio)
      : null;

  const headline = top && bot
    ? `${chartSpec.y} varies a lot across ${dimensionLabel} — "${top.x}" at ${formatY(top.y)} is ${ratio ?? "many times"} "${bot.x}" at ${formatY(bot.y)}.`
    : `${chartSpec.y} varies a lot across ${dimensionLabel}.`;

  const driver =
    p.segmentsAboveP75.length > 0 || p.segmentsBelowP25.length > 0
      ? `The gap is wide and consistent: ${p.segmentsAboveP75.length > 0 ? `${namedSegments(p.segmentsAboveP75)} sit clearly in the top quartile` : ""}${p.segmentsAboveP75.length > 0 && p.segmentsBelowP25.length > 0 ? "; " : ""}${p.segmentsBelowP25.length > 0 ? `${namedSegments(p.segmentsBelowP25)} sit clearly in the bottom quartile` : ""}.`
      : `The spread is wide enough that an average-based plan will miss in either direction depending on the segment.`;

  const risk = `Comparing the bottom directly to the top assumes they face the same conditions — they often don't, so the achievable lift is usually less than the gap suggests.`;

  const nextCheck = `Next: pull a same-period view of ${top ? `"${top.x}"` : "the top group"} and ${bot ? `"${bot.x}"` : "the bottom group"} side by side, and compare them only on dimensions you can actually verify.`;

  return { headline, driver, risk, nextCheck };
}

function relationshipNarrative({ patterns: p, chartSpec, formatY }: Args): FourClaim {
  const r = p.yY2Correlation;
  const strength = p.yY2Strength;
  const direction = r !== undefined && r >= 0 ? "in the same direction" : "in opposite directions";
  const top = p.topPerformers[0];

  const headline =
    r !== undefined
      ? `${chartSpec.y} and ${(chartSpec as any).y2 ?? "the secondary metric"} move ${direction} (${strength} link) across the plotted points.`
      : `${chartSpec.y} and the secondary metric track each other.`;

  const driver = top
    ? `The link is most visible at "${top.x}" (${formatY(top.y)}), where both metrics are at their highest.`
    : `The two metrics rise and fall together across the dimension.`;

  const risk = `Two metrics moving together does not mean one causes the other — a third factor can move both at the same time and the link can break out-of-sample.`;

  const nextCheck = `Next: hold one dimension fixed (same period, same segment, etc.) and re-check whether the link still holds — if it does, the relationship is more likely to be real.`;

  return { headline, driver, risk, nextCheck };
}

function diagnosticNarrative({ patterns: p, chartSpec, dimensionLabel, formatY }: Args): FourClaim {
  const top = p.topPerformers[0];
  const median = p.median;

  const headline = top
    ? `${chartSpec.y} is fairly evenly spread across ${dimensionLabel} — the leader "${top.x}" at ${formatY(top.y)} is only modestly above the typical level (${median !== undefined ? formatY(median) : "N/A"}), so no single ${dimensionLabel} carries the metric.`
    : `${chartSpec.y} is broadly spread with no dominant ${dimensionLabel}.`;

  const driver = `No single ${dimensionLabel} stands out as a clear leader, and the spread between segments is moderate. The chart on its own does not point to a clear lever.`;

  const risk = `When the distribution is flat and even, a broad push spreads effort thinly without a clear target. The next signal has to come from a different cut of the data.`;

  const nextCheck = `Next: bring in a second dimension you have available — time period, customer group, or product mix — and re-pivot. The flat shape here suggests the real driver lives one cut deeper.`;

  return { headline, driver, risk, nextCheck };
}

function selectFourClaim(args: Args): { family: DeterministicFallbackFamily; claim: FourClaim } {
  const family = selectFallbackFamily(args.patterns);
  switch (family) {
    case "trend":
      return { family, claim: trendNarrative(args) };
    case "concentration":
      return { family, claim: concentrationNarrative(args) };
    case "dispersion":
      return { family, claim: dispersionNarrative(args) };
    case "relationship":
      return { family, claim: relationshipNarrative(args) };
    case "diagnostic":
    default:
      return { family, claim: diagnosticNarrative(args) };
  }
}

export function buildPatternDrivenFallback(args: Args): {
  family: DeterministicFallbackFamily;
  text: string;
} {
  const { family, claim } = selectFourClaim(args);
  return {
    family,
    text: [claim.headline, claim.driver, claim.risk, claim.nextCheck].filter(Boolean).join(" "),
  };
}

/**
 * Same family selection as `buildPatternDrivenFallback`, but emits the
 * 4-claim shape mapped to a structured envelope: the headline + driver
 * become the finding (with magnitude when available), the risk becomes
 * the implication, the next-check becomes the recommendation. Used by
 * `pivotEnvelope` when the LLM call fails or pivot-bearing turns lack
 * an answer envelope.
 */
export function buildPatternDrivenEnvelope(args: Args): {
  family: DeterministicFallbackFamily;
  findings: { headline: string; evidence: string; magnitude?: string }[];
  implications: { statement: string; soWhat: string }[];
  recommendations: { action: string; rationale: string }[];
} {
  const { family, claim } = selectFourClaim(args);
  const p = args.patterns;

  let magnitude: string | undefined;
  if (family === "concentration" && p.top1Share !== undefined) {
    magnitude = `${(p.top1Share * 100).toFixed(0)}% from the top segment`;
  } else if (family === "trend" && p.recentVsPriorDelta !== undefined) {
    const sign = p.recentVsPriorDelta >= 0 ? "+" : "";
    magnitude = `${sign}${(p.recentVsPriorDelta * 100).toFixed(1)}% recent vs prior`;
  } else if (
    family === "dispersion" &&
    p.topToBottomRatio !== undefined &&
    Number.isFinite(p.topToBottomRatio)
  ) {
    magnitude = `top is ${p.topToBottomRatio.toFixed(1)}× the bottom`;
  } else if (family === "relationship" && p.yY2Correlation !== undefined) {
    const dir = p.yY2Correlation >= 0 ? "same-direction" : "opposite-direction";
    magnitude = `${p.yY2Strength ?? "moderate"} ${dir} link`;
  }

  return {
    family,
    findings: [
      {
        headline: claim.headline,
        evidence: claim.driver,
        ...(magnitude ? { magnitude } : {}),
      },
    ],
    implications: [
      {
        statement: claim.headline,
        soWhat: claim.risk,
      },
    ],
    recommendations: [
      {
        action: claim.nextCheck.replace(/^Next:\s*/i, ""),
        rationale: claim.driver,
      },
    ],
  };
}
