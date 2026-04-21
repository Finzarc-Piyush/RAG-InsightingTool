// Metric vocabulary — match a header token against known Nielsen /
// syndicated-panel metric names. Deterministic, LLM-free.
//
// Returns the canonical metric name so the melt output's `_metric`
// column is consistent regardless of source spelling.
//
// Scope (W2): Nielsen-primary vocabulary. Kantar / Circana variants
// can be layered in as a follow-up wave without breaking callers
// (see wide-format.md "Extension points").

export interface MetricMatch {
  canonical: string;
  confidence: number;
  raw: string;
}

interface Rule {
  canonical: string;
  /** Patterns matched against the NORMALIZED token (lowercased, collapsed whitespace). */
  patterns: RegExp[];
  confidence: number;
}

// Order matters: more specific rules come first so "value share" is
// not shadowed by a bare "value" rule.
const RULES: Rule[] = [
  {
    canonical: "Value Sales",
    confidence: 0.95,
    patterns: [
      /^value(?:\s*sales)?$/,
      /^(?:rs|inr|usd|\$|₹)\s*(?:value\s*)?sales$/,
      /^sales\s+value$/,
      /^rupee\s+sales$/,
      /^value\s+offtake$/,
      /^val(?:\.|ue)?\s*sal(?:es)?$/,
    ],
  },
  {
    canonical: "Volume Sales",
    confidence: 0.95,
    patterns: [
      /^volume(?:\s*sales)?$/,
      /^unit\s*sales$/,
      /^units?$/,
      /^(?:kg|kgs|litres?|liters?|ml|ltr)\s*sales$/,
      /^sales\s+volume$/,
      /^vol(?:\.|ume)?\s*sal(?:es)?$/,
      /^volume\s+offtake$/,
    ],
  },
  {
    canonical: "Value Share",
    confidence: 0.95,
    patterns: [
      /^value\s*share$/,
      /^val(?:\.|ue)?\s*share$/,
      /^market\s*share\s*(?:value|val)?$/,
      /^share\s+of\s+value$/,
      /^ms\s*(?:value|val)$/,
    ],
  },
  {
    canonical: "Volume Share",
    confidence: 0.95,
    patterns: [
      /^volume\s*share$/,
      /^vol(?:\.|ume)?\s*share$/,
      /^market\s*share\s*(?:volume|vol)$/,
      /^share\s+of\s+volume$/,
      /^ms\s*(?:volume|vol)$/,
    ],
  },
  {
    canonical: "Weighted Distribution",
    confidence: 0.95,
    patterns: [
      /^weighted\s*distribution$/,
      /^wtd\s*dist(?:ribution)?$/,
      /^w\.?d\.?$/, // "WD" / "W.D."
      /^%?\s*wtd\s*dist$/,
    ],
  },
  {
    canonical: "Numeric Distribution",
    confidence: 0.95,
    patterns: [
      /^numeric\s*distribution$/,
      /^num(?:eric)?\s*dist(?:ribution)?$/,
      /^n\.?d\.?$/, // "ND"
      /^%?\s*num\s*dist$/,
    ],
  },
  {
    canonical: "ACV",
    confidence: 0.9,
    patterns: [
      /^acv$/,
      /^acv\s*%?$/,
      /^%?\s*acv$/,
      /^all\s*commodity\s*volume$/,
    ],
  },
  {
    canonical: "TDP",
    confidence: 0.9,
    patterns: [
      /^tdp$/,
      /^total\s*distribution\s*points$/,
    ],
  },
  {
    canonical: "Penetration",
    confidence: 0.9,
    patterns: [
      /^pen(?:etration)?$/,
      /^hh\s*pen(?:etration)?$/,
      /^household\s*pen(?:etration)?$/,
      /^%?\s*pen(?:etration)?$/,
    ],
  },
  {
    canonical: "Loyalty",
    confidence: 0.9,
    patterns: [
      /^loyalty$/,
      /^brand\s*loyalty$/,
      /^%?\s*loyalty$/,
    ],
  },
  {
    canonical: "Frequency",
    confidence: 0.85,
    patterns: [
      /^frequency$/,
      /^freq(?:\.)?$/,
      /^purchase\s*frequency$/,
      /^buying\s*frequency$/,
    ],
  },
  {
    canonical: "Average Price",
    confidence: 0.9,
    patterns: [
      /^avg\s*price$/,
      /^average\s*price$/,
      /^price$/,
      /^price\s*per\s*(?:unit|kg|l|ltr|ml|litre|liter)$/,
      /^price\s*\/\s*(?:unit|kg|l|ltr|ml|litre|liter)$/,
      /^unit\s*price$/,
    ],
  },
  {
    canonical: "Shopper Spend",
    confidence: 0.85,
    patterns: [
      /^shopper\s*spend$/,
      /^spend\s*per\s*buyer$/,
      /^buyer\s*spend$/,
    ],
  },
];

// Normalize a token: lowercase, collapse whitespace, strip surrounding
// punctuation that doesn't affect meaning (currency symbols handled by
// the patterns themselves).
function normalize(token: string): string {
  return token
    .toLowerCase()
    .trim()
    .replace(/[  -​]+/g, " ")
    .replace(/\s+/g, " ")
    // Strip surrounding punctuation except % (meaningful for percentage metrics).
    .replace(/^[\s\-_:,;]+|[\s\-_:,;]+$/g, "");
}

/**
 * Match a token against the metric vocabulary. Returns the canonical
 * form + confidence, or null when nothing matches.
 */
export function matchMetric(token: string): MetricMatch | null {
  if (!token || typeof token !== "string") return null;
  const norm = normalize(token);
  if (!norm) return null;
  for (const rule of RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(norm)) {
        return {
          canonical: rule.canonical,
          confidence: rule.confidence,
          raw: token,
        };
      }
    }
  }
  return null;
}

export const __internal__ = { normalize, RULES };
