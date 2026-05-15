import { ArchiveRestore } from "lucide-react";
import type { Message } from "@/shared/schema";

/**
 * AMR5 · Provenance pill rendered above the AnswerCard when an assistant
 * message was served from the `past_analyses` cross-session cache (exact
 * match on the normalized question, or semantic ≥0.92 match). Signals to
 * the user that the rich card mounted here was produced by an earlier
 * analytical turn — and includes a relative timestamp so they can judge
 * whether the data version is still current.
 *
 * Matches the AutomationReplayBanner aesthetic (small bordered pill, muted
 * tone). Semantic token classes only per [`client/THEMING.md`].
 *
 * No-op when the field is absent — fresh agent turns leave it unset.
 */

type RecallMeta = NonNullable<Message["recalledFromPriorAnalysis"]>;

function formatAge(originalCreatedAt: number): string {
  const diffMs = Date.now() - originalCreatedAt;
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} month${month === 1 ? "" : "s"} ago`;
  const year = Math.floor(day / 365);
  return `${year} year${year === 1 ? "" : "s"} ago`;
}

interface Props {
  recalled: RecallMeta | undefined;
}

export function RecalledFromPriorAnalysisChip({ recalled }: Props) {
  if (!recalled) return null;
  const age = formatAge(recalled.originalCreatedAt);
  const matchLabel =
    recalled.matchKind === "exact"
      ? "Recalled from prior analysis"
      : "Similar to a prior analysis";
  return (
    <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <ArchiveRestore className="h-3 w-3" aria-hidden />
      <span>{matchLabel}</span>
      <span aria-hidden>·</span>
      <span>{age}</span>
    </div>
  );
}
