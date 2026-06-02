/**
 * Single source of truth for turning a `past_analyses` doc's feedback into
 * up/down vote counts.
 *
 * Chart-level votes live ONLY in `feedbackDetails[]` — the root `feedback`
 * field stays "none" for them (only the answer-level vote is mirrored to the
 * root). So counting only the root field silently drops every per-chart thumb.
 * We count every detail; for legacy docs written before `feedbackDetails`
 * existed we fall back to the root field.
 *
 * Leaf module (no imports) so both the metrics aggregator and the per-session
 * badge aggregator can share it without a circular dependency.
 */

export interface FeedbackVoteSource {
  feedback?: string | null;
  feedbackDetails?: Array<{ feedback?: string | null }> | null;
}

export function countTurnVotes(row: FeedbackVoteSource): { up: number; down: number } {
  const details = row.feedbackDetails ?? [];
  if (details.length > 0) {
    let up = 0;
    let down = 0;
    for (const d of details) {
      if (d?.feedback === "up") up += 1;
      else if (d?.feedback === "down") down += 1;
    }
    return { up, down };
  }
  if (row.feedback === "up") return { up: 1, down: 0 };
  if (row.feedback === "down") return { up: 0, down: 1 };
  return { up: 0, down: 0 };
}
