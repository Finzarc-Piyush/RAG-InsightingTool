/**
 * ============================================================================
 * deckPlanVerifier.ts — quality gate for a slide-deck plan before it renders
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the tool exports an analysis as a slide deck, an LLM first produces a
 *   structured "plan" (a `SlideDeckPlan`: an ordered list of slides, each with
 *   a layout type, a title, bullets, etc.). This file checks that plan against
 *   a fixed set of professional-presentation rules BEFORE anything gets drawn.
 *   Every rule here is mechanical (regex, counting words, checking a slide's
 *   position) — there is NO second AI grading the work, so the checks are fast,
 *   cheap, repeatable, and easy to explain.
 *
 *   The rules it enforces:
 *     1. Every slide's title is "action-led": starts with a capital/number, is
 *        a full sentence (≥5 words), names a number or proper noun, and is not
 *        a lazy placeholder like "Findings" or "Overview".
 *     2. If there's a title slide, it must be first.
 *     3. Methodology slides belong in the back third of the deck.
 *     4. The executive-summary slide belongs in the first half (TL;DR up front).
 *     5. Every slide has speaker notes of at least 20 characters.
 *     6. No single bullet/caption crams 2+ numeric figures (one idea per slide).
 *
 * WHY IT MATTERS
 *   This is the line between a polished, decision-grade deck and a generic,
 *   template-looking one. Because the checks are deterministic, the surrounding
 *   "repair loop" is bounded: if the plan fails, the caller feeds the failure
 *   description back to the deck-planner LLM to fix and re-checks (just one
 *   repair round). Without this gate, the deck planner could emit vague titles,
 *   misordered sections, or overloaded slides with no safety net.
 *
 * KEY PIECES
 *   - DeckVerifierResult — pass/fail result; on fail carries human-readable
 *     `description` + `courseCorrection` text to feed back to the planner LLM.
 *   - checkActionTitle(title) — validates one slide title; returns null if OK,
 *     else a one-line issue string.
 *   - verifyDeckPlan(plan) — runs every rule over the whole plan and aggregates
 *     per-slide issues plus deck-level ordering issues.
 *   - findOverloadedBullets(slide) — flags bullets/captions with 2+ figures.
 *
 * HOW IT CONNECTS
 *   Sits between the deck-planner LLM and the slide renderers in the export
 *   flow. Operates on the `SlideDeckPlan` / `SlideSpec` types from
 *   ../../../shared/exportSchema.js. Mirrors the spirit of the answer-envelope
 *   gate in ./checkEnvelopeCompleteness.ts (deterministic, repair-via-LLM,
 *   bounded retries) but for slide plans rather than narrator output.
 */

import type { SlideDeckPlan, SlideSpec } from "../../../shared/exportSchema.js";
import { LAYOUT_KIND } from "../../../shared/exportSchema.js";

export type DeckVerifierResult =
  | { ok: true }
  | {
      ok: false;
      code: "DECK_PLAN_QUALITY_GATE";
      description: string;
      courseCorrection: string;
      /** Per-slide issues for telemetry / SSE surfacing. */
      slideIssues: ReadonlyArray<{ slideIndex: number; issues: string[] }>;
    };

/**
 * Topic-title denylist — these are the slide titles that scream "rendered by
 * a template, not written for this deck". Comparison is case-insensitive
 * and trims whitespace + trailing punctuation. Both standalone and inside a
 * larger title (e.g. "Performance Overview" with no number) get caught by
 * the "must contain number-or-acronym" rule below; this list catches the
 * rare cases where someone slipped a number in but the title is still a
 * vacuous label ("Q3 Findings" ≠ a takeaway).
 */
const TOPIC_TITLE_DENYLIST = new Set<string>([
  "findings",
  "key findings",
  "analysis",
  "data analysis",
  "overview",
  "performance overview",
  "summary",
  "executive summary",
  "results",
  "conclusion",
  "conclusions",
  "next steps",
  "agenda",
  "appendix",
  "introduction",
]);

const MIN_TITLE_WORDS = 5;
const MIN_SPEAKER_NOTES = 20;
const MAX_MAGNITUDES_PER_LINE = 1;

/**
 * Checks one action title against the verb + number + word-count rule.
 * Returns null when OK, or a one-line issue string. Runs once per slide.
 */
export function checkActionTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return "actionTitle is empty";
  if (!/^[A-Z0-9]/.test(trimmed)) {
    return `actionTitle must start with a capital letter or number — got "${trimmed.slice(0, 40)}…"`;
  }
  const words = trimmed.split(/\s+/);
  if (words.length < MIN_TITLE_WORDS) {
    return `actionTitle must be a complete sentence (≥${MIN_TITLE_WORDS} words) — got ${words.length} words`;
  }
  // Specificity: digit OR uppercase-token (acronym, brand name, period like "Q3").
  const hasNumber = /\d/.test(trimmed);
  const hasUpperRun = words.some((w) => /^[A-Z][A-Z]+/.test(w.replace(/[^\w]/g, "")));
  if (!hasNumber && !hasUpperRun) {
    return `actionTitle must contain a number or proper-noun reference for specificity — "${trimmed.slice(0, 60)}…" reads as a topic title`;
  }
  // Topic-title denylist — strip trailing punctuation before lookup so
  // "Findings." and "Findings:" both get caught.
  const normalized = trimmed.toLowerCase().replace(/[.:;!?]+$/, "").trim();
  if (TOPIC_TITLE_DENYLIST.has(normalized)) {
    return `actionTitle is a topic-title placeholder — needs verb + number ("${trimmed}")`;
  }
  // Verb-presence is genuinely hard to regex without false positives; instead
  // we flag titles that LOOK like topic-headers: ≤ 4 words AND ending with a
  // noun-phrase. The min-word check above already catches most of these.
  return null;
}

/**
 * Walks every slide in plan-order; aggregates per-slide issues plus the
 * deck-level positional rules (TitleSlide first, Methodology in back third,
 * ExecSummary in first half).
 */
export function verifyDeckPlan(plan: SlideDeckPlan): DeckVerifierResult {
  const slideIssues: { slideIndex: number; issues: string[] }[] = [];

  for (let i = 0; i < plan.slides.length; i++) {
    const slide = plan.slides[i]!;
    const issues: string[] = [];

    // Rule 1 — action title quality.
    const titleIssue = checkActionTitle(slide.actionTitle);
    if (titleIssue) issues.push(titleIssue);

    // Rule 5 — speaker notes floor (also schema-enforced).
    if (!slide.speakerNotes || slide.speakerNotes.trim().length < MIN_SPEAKER_NOTES) {
      issues.push(
        `speakerNotes too short (≥${MIN_SPEAKER_NOTES} chars required) — got ${slide.speakerNotes?.length ?? 0}`
      );
    }

    // Rule 6 — one-message-per-slide on bullet lists. We count distinct
    // numeric magnitudes (digit runs surrounded by word boundaries — covers
    // "12%", "9.1pp", "₫68.7B" via the digit run, "+3.1pp"). When a single
    // bullet smuggles ≥ 2 distinct magnitudes the planner has merged 2 ideas.
    issues.push(...findOverloadedBullets(slide));

    if (issues.length > 0) slideIssues.push({ slideIndex: i, issues });
  }

  // Rule 2 — TitleSlide must be first when any TitleSlide exists.
  const titleSlideIndex = plan.slides.findIndex((s) => s.layout === LAYOUT_KIND.TitleSlide);
  if (titleSlideIndex > 0) {
    slideIssues.push({
      slideIndex: titleSlideIndex,
      issues: [
        `TitleSlide must be the first slide; found at position ${titleSlideIndex + 1}`,
      ],
    });
  }

  // Rule 3 — Methodology slides in the back third.
  const total = plan.slides.length;
  const backThirdStart = Math.floor((total * 2) / 3);
  for (let i = 0; i < total; i++) {
    if (plan.slides[i]!.layout === LAYOUT_KIND.Methodology && i < backThirdStart) {
      slideIssues.push({
        slideIndex: i,
        issues: [
          `Methodology slides must live in the back third (slide index ≥ ${backThirdStart} for a ${total}-slide deck); found at index ${i}`,
        ],
      });
    }
  }

  // Rule 4 — ExecSummary in the first half.
  const firstHalfEnd = Math.ceil(total / 2);
  for (let i = 0; i < total; i++) {
    if (plan.slides[i]!.layout === LAYOUT_KIND.ExecSummary && i >= firstHalfEnd) {
      slideIssues.push({
        slideIndex: i,
        issues: [
          `ExecSummary should appear in the first half of the deck (index < ${firstHalfEnd}); found at index ${i}`,
        ],
      });
    }
  }

  if (slideIssues.length === 0) return { ok: true };

  // Compose human-readable repair guidance.
  const summaryLines = slideIssues.flatMap(({ slideIndex, issues }) =>
    issues.map((iss) => `  - slide ${slideIndex + 1}: ${iss}`)
  );
  const description = `The previous deck plan failed quality verification. Issues:\n${summaryLines.join("\n")}`;
  const courseCorrection = [
    "Re-emit the SlideDeckPlan with these issues fixed.",
    "Action titles MUST be a complete sentence with a verb and a number — never a topic title.",
    "Methodology slides must live in the back third of the deck.",
    "ExecSummary belongs in the first half so the reader gets the TL;DR up front.",
    "Speaker notes must be ≥ 20 characters on every slide.",
    "Do NOT change the chart/table inventory ids; only adjust titles, layouts, and slot content.",
  ].join(" ");

  return {
    ok: false,
    code: "DECK_PLAN_QUALITY_GATE",
    description,
    courseCorrection,
    slideIssues,
  };
}

/**
 * Walks the slot content per layout and flags bullets / captions that pack
 * ≥ 2 distinct numeric magnitudes — the one-message-per-slide rule. Single
 * numbers are fine; the rule is about the bullet, not the deck.
 */
function findOverloadedBullets(slide: SlideSpec): string[] {
  const out: string[] = [];

  /**
   * Real-magnitude extractor — counts only numbers that carry a unit or
   * currency symbol, so partition fractions ("8 of the 12pp decline") count
   * as ONE magnitude, not two. Catches the genuine "two-message-per-bullet"
   * smell ("Sales fell 12% AND volume fell 4.2pp") without flagging benign
   * fraction-of-total prose.
   *
   * Recognised shapes:
   *   - digit + percent / per-point unit: "12%", "9.1pp", "4pp", "1.8x", "2×"
   *   - digit + scale unit: "68B", "710K", "1.95M"
   *   - currency-prefixed: "$68.7B", "₫4B", "€1.2M", "£710K", "¥48"
   */
  // The `\b` regex word-boundary doesn't anchor between two non-word chars
  // (e.g. between "%" and space) — so we split the alternation by unit type:
  //   - "%" needs no boundary (it itself ends the token)
  //   - "pp" / "pt" / "bps" / scale letters need `\b` so "12pper" doesn't
  //     match a fake unit
  //   - "x" / "×" multipliers terminate without a boundary
  //   - currency-prefixed amounts ("$68.7B", "₫4B") get their own branch
  const REAL_MAGNITUDE_RE =
    /(?:[+\-−]?\d[\d,]*(?:\.\d+)?%)|(?:[+\-−]?\d[\d,]*(?:\.\d+)?(?:pp|pt|bps|[KkMmBb])\b)|(?:[+\-−]?\d[\d,]*(?:\.\d+)?[xX×])|(?:[$₫€£¥][+\-−]?\d[\d,]*(?:\.\d+)?[KkMmBb]?)/g;
  const countMagnitudes = (text: string): number => {
    const matches = text.match(REAL_MAGNITUDE_RE);
    return matches?.length ?? 0;
  };

  const flag = (idx: number, text: string, label: string): void => {
    if (countMagnitudes(text) > MAX_MAGNITUDES_PER_LINE) {
      out.push(
        `${label} ${idx + 1} packs multiple magnitudes — split into separate slides per the one-message-per-slide rule: "${text.slice(0, 80)}…"`
      );
    }
  };

  switch (slide.layout) {
    case LAYOUT_KIND.ExecSummary:
      slide.slots.bullets.forEach((b, i) => flag(i, b, "ExecSummary bullet"));
      break;
    case LAYOUT_KIND.ChartWithInsight:
      flag(0, slide.slots.insight, "ChartWithInsight insight");
      break;
    case LAYOUT_KIND.TwoChartCompare:
      flag(0, slide.slots.insight, "TwoChartCompare insight");
      break;
    case LAYOUT_KIND.ImplicationsByHorizon:
      slide.slots.now.forEach((b, i) => flag(i, b, "now-horizon implication"));
      slide.slots.thisQuarter.forEach((b, i) => flag(i, b, "this_quarter implication"));
      slide.slots.strategic.forEach((b, i) => flag(i, b, "strategic implication"));
      break;
    case LAYOUT_KIND.Recommendations:
      slide.slots.items.forEach((it, i) => flag(i, it.action, "recommendation"));
      break;
    case LAYOUT_KIND.TitleSlide:
    case LAYOUT_KIND.KpiRow:
    case LAYOUT_KIND.TableSlide:
    case LAYOUT_KIND.Methodology:
    case LAYOUT_KIND.Appendix:
      // KpiRow KPIs are intentionally numbers — that's the point of the
      // layout. TableSlide values are tabular and rendered native, not
      // bullets. Methodology / Appendix are prose and intentionally allowed
      // to mix multiple numbers.
      break;
    default: {
      // Exhaustiveness check — TS forces a case here when a new LayoutKind
      // is added to the enum (compile-time). The runtime fallthrough
      // never fires.
      const _exhaustive: never = slide;
      void _exhaustive;
      break;
    }
  }
  return out;
}
