import type { ChartSpec } from "../../shared/schema.js";
import { callLlm } from "../agents/runtime/callLlm.js";
import { LLM_PURPOSE } from "../agents/runtime/llmCallPurpose.js";
import {
  getInsightModel,
  getInsightTemperatureConservative,
} from "../insightSynthesis/insightModelConfig.js";
import {
  computePivotPatterns,
  renderPivotPatternsBlock,
} from "./pivotPatterns.js";
import { buildPatternDrivenEnvelope } from "./deterministicNarratives.js";
import { resolveTopPerfDimension } from "../insightGenerator.js";

export type PivotEnvelopeFinding = {
  headline: string;
  evidence: string;
  magnitude?: string;
};
export type PivotEnvelopeImplication = {
  statement: string;
  soWhat: string;
};
export type PivotEnvelopeRecommendation = {
  action: string;
  rationale: string;
};
export type PivotEnvelope = {
  findings: PivotEnvelopeFinding[];
  implications: PivotEnvelopeImplication[];
  recommendations: PivotEnvelopeRecommendation[];
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const trim = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

const sanitizeFindings = (raw: unknown): PivotEnvelopeFinding[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (!f || typeof f !== "object") return null;
      const r = f as Record<string, unknown>;
      const headline = isNonEmptyString(r.headline) ? r.headline.trim() : "";
      const evidence = isNonEmptyString(r.evidence) ? r.evidence.trim() : "";
      if (!headline && !evidence) return null;
      return {
        headline: trim(headline, 200),
        evidence: trim(evidence, 600),
        ...(isNonEmptyString(r.magnitude) ? { magnitude: trim(r.magnitude.trim(), 80) } : {}),
      } as PivotEnvelopeFinding;
    })
    .filter((v): v is PivotEnvelopeFinding => v !== null)
    .slice(0, 4);
};

const sanitizeImplications = (raw: unknown): PivotEnvelopeImplication[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) => {
      if (!i || typeof i !== "object") return null;
      const r = i as Record<string, unknown>;
      const statement = isNonEmptyString(r.statement) ? r.statement.trim() : "";
      const soWhat = isNonEmptyString(r.soWhat) ? r.soWhat.trim() : "";
      if (!statement && !soWhat) return null;
      return {
        statement: trim(statement, 280),
        soWhat: trim(soWhat, 280),
      } as PivotEnvelopeImplication;
    })
    .filter((v): v is PivotEnvelopeImplication => v !== null)
    .slice(0, 3);
};

const sanitizeRecommendations = (raw: unknown): PivotEnvelopeRecommendation[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((rec) => {
      if (!rec || typeof rec !== "object") return null;
      const r = rec as Record<string, unknown>;
      const action = isNonEmptyString(r.action) ? r.action.trim() : "";
      const rationale = isNonEmptyString(r.rationale) ? r.rationale.trim() : "";
      if (!action && !rationale) return null;
      return {
        action: trim(action, 200),
        rationale: trim(rationale, 280),
      } as PivotEnvelopeRecommendation;
    })
    .filter((v): v is PivotEnvelopeRecommendation => v !== null)
    .slice(0, 3);
};

const SHALLOW_PATTERNS = [
  /increase\s+\w+\s+where\s+\w+\s+is\s+low/i,
  /lift\s+the\s+(weaker|lower|bottom)\s+segments?/i,
  /focus\s+on\s+(the\s+)?(top|leader)\b(?!.*(price|distribution|mix|channel|segment|cadence|season|format|sku|store))/i,
  /prioritize\s+(the\s+)?\w+\s+(?!by\b)/i,
];

const isShallow = (text: string): boolean =>
  SHALLOW_PATTERNS.some((re) => re.test(text));

export type GeneratePivotEnvelopeInput = {
  chartSpec: ChartSpec;
  chartData: Record<string, unknown>[];
  formatY: (n: number) => string;
  userQuestion?: string;
  domainContext?: string;
};

/**
 * Wave 3 · narrator-style structured envelope for the pivot view. Produces
 * findings → implications → recommendations grounded in PIVOT PATTERNS so the
 * pivot tab's "Key insight" reads like the chat-analysis InsightCard rather
 * than a single-sentence chart caption. Falls back to the pattern-driven
 * deterministic envelope on LLM failure or shallow output.
 */
export async function generatePivotEnvelope(
  input: GeneratePivotEnvelopeInput
): Promise<PivotEnvelope> {
  const { chartSpec, chartData, formatY, userQuestion, domainContext } = input;
  if (!chartData || chartData.length === 0) {
    return { findings: [], implications: [], recommendations: [] };
  }

  const patterns = computePivotPatterns(chartData, {
    x: chartSpec.x,
    y: chartSpec.y,
    type: chartSpec.type,
    seriesKeys: chartSpec.seriesKeys,
    y2: (chartSpec as any).y2,
  });
  const dimensionLabel = resolveTopPerfDimension(chartSpec);
  const patternsBlock = renderPivotPatternsBlock(patterns, formatY);

  const deterministicEnvelope = (): PivotEnvelope => {
    const env = buildPatternDrivenEnvelope({
      patterns,
      chartSpec,
      dimensionLabel,
      formatY,
    });
    return {
      findings: env.findings,
      implications: env.implications,
      recommendations: env.recommendations,
    };
  };

  const top = patterns.topPerformers[0];
  const bot = patterns.bottomPerformers[0];
  const factsLines: string[] = [];
  factsLines.push(
    `DATA FACTS (rows: ${patterns.rowCount}, total ${formatY(patterns.total)}):`
  );
  if (top) factsLines.push(`- Leader: ${dimensionLabel} "${top.x}" at ${formatY(top.y)}`);
  if (bot) factsLines.push(`- Laggard: ${dimensionLabel} "${bot.x}" at ${formatY(bot.y)}`);
  if (patterns.median !== undefined)
    factsLines.push(`- Median: ${formatY(patterns.median)}`);

  const userBlock = isNonEmptyString(userQuestion)
    ? `\n\nUSER QUESTION (prioritize an envelope that answers this):\n${userQuestion.trim().slice(0, 1500)}`
    : "";
  const domainBlock = isNonEmptyString(domainContext)
    ? `\n\nFMCG / MARICO DOMAIN CONTEXT (orientation only, never numeric evidence; cite pack id when used):\n${domainContext.trim().slice(0, 2000)}`
    : "";

  const userPrompt = `Return JSON with the listed fields.

TASK: Produce a structured "key insight" envelope for the pivot view that summarises THIS chart's data for a decision-maker. Each entry must ground in DATA FACTS and PIVOT PATTERNS — never invent numbers.

VOICE — your reader is a manager / CXO, NOT a statistician:
- Never use these terms in user-visible output: HHI, CV, IQR, P25, P50, P75, "long tail", "Pearson r", "percentile". Use plain English instead ("concentrated", "varies a lot", "fairly stable", "in the bottom quartile", "moves in the same direction").
- Never assert decline, weakness, or risk in a way that sounds accusatory. Use neutral, observational language ("South contributed 17% of the total" — not "South is underperforming and signals distribution failures").
- Frame magnitudes in K / M / B, never raw decimals (e.g. "710K", not "710,212.40").

ANTI-PATTERNS — refuse:
- Inventing causal mechanisms the data cannot show. Specifically: do NOT mention price, distribution, brand, channel, premiumisation, competition, market penetration, customer demographics, advertising, supply chain, or any other column not present in DATA FACTS. The available columns are listed in DATA FACTS — you may reason only about those.
- Recommendations that ask the reader to launch new products, enter new categories, change channels, or make any executive-level strategic decision. The user running this tool is an analyst, not a CEO.
- "Increase {y} where {y} is low", "lift the laggards", "focus on the leader" without naming a *next analytical step* tied to a column the data actually has.
- Any sentence whose entire content is "X has the highest Y / X has the lowest Y".
- Generic "monitor" / "investigate further" recommendations.

If you cannot identify a next step grounded in available columns, propose a *diagnostic split by an existing column* in the recommendation instead — frame as "compare X vs Y on dimension Z" or "look at this metric over time".

${factsLines.join("\n")}

${patternsBlock}${userBlock}${domainBlock}

OUTPUT JSON (exact keys only):
{
  "findings": [
    { "headline": "≤200 chars: the claim, plain English", "evidence": "≤600 chars: the numeric grounding using K/M/B", "magnitude": "optional, ≤80 chars: e.g. '31% from top region', '+12.4% recent vs prior', 'top is 1.8× the bottom'" }
  ],
  "implications": [
    { "statement": "≤280 chars: observed pattern, neutral observational tone", "soWhat": "≤280 chars: business meaning — risk, dependence, ceiling, opportunity — without speculating on causes the data cannot show" }
  ],
  "recommendations": [
    { "action": "≤200 chars: a specific *analytical next step* using columns the data has — comparing slices, splitting by an available dimension, looking over time", "rationale": "≤280 chars: why this analytical step targets the pattern" }
  ]
}

Aim for 1–3 findings, 1–3 implications, 1–3 recommendations. Quality > quantity. Do not pad.`;

  try {
    const response = await callLlm(
      {
        model: getInsightModel() as string,
        messages: [
          {
            role: "system",
            content:
              `You are a senior analyst writing the "key insight" envelope shown above a pivot table for a manager / CXO reader. Return JSON with keys "findings", "implications", "recommendations". Each entry must ground in the provided numbers — never invent. Plain-English vocabulary only: never use HHI, CV, IQR, P25/P50/P75, "long tail", "Pearson r", or "percentile" in user-visible output; say "concentrated / spread out", "varies a lot / fairly stable", "in the top/bottom quartile", "moves in the same direction" instead. Always abbreviate magnitudes ≥1000 with K / M / B; never raw decimals like 710,212.40. Recommendations must be ANALYTICAL next steps grounded in columns that actually exist in DATA FACTS — never invent mechanisms (channel, distribution, brand, competition, premiumisation, etc.) the data does not contain, and never recommend executive decisions like launching products or entering categories. Tone is neutral and observational, never accusatory. No markdown.`,
          },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: getInsightTemperatureConservative(),
        max_tokens: 1400,
      },
      { purpose: LLM_PURPOSE.INSIGHT_GEN }
    );

    const content = response.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    const envelope: PivotEnvelope = {
      findings: sanitizeFindings(parsed?.findings),
      implications: sanitizeImplications(parsed?.implications),
      recommendations: sanitizeRecommendations(parsed?.recommendations),
    };

    const everyText = [
      ...envelope.findings.map((f) => `${f.headline} ${f.evidence}`),
      ...envelope.implications.map((i) => `${i.statement} ${i.soWhat}`),
      ...envelope.recommendations.map((r) => `${r.action} ${r.rationale}`),
    ].join(" ");

    if (
      envelope.findings.length === 0 &&
      envelope.implications.length === 0 &&
      envelope.recommendations.length === 0
    ) {
      return deterministicEnvelope();
    }
    if (isShallow(everyText)) {
      return deterministicEnvelope();
    }
    return envelope;
  } catch (error) {
    console.error("Error generating pivot envelope:", error);
    return deterministicEnvelope();
  }
}
