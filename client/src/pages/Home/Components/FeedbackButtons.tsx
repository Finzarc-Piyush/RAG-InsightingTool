/**
 * W5.5b · Thumbs up/down on a completed assistant turn.
 * W9 · Adds reason chips + free-text comment after thumbs-down so the team
 *      can slice "what went wrong" by category, not just count negative votes.
 *
 * Granular targets · `target` prop addresses one of: the answer (default),
 * a spawned sub-question, or the pivot view. Backed by `feedbackDetails[]`
 * on the past-analysis doc — see `pastAnalysisFeedbackTargetSchema`.
 *
 * Layouts · `layout="block"` keeps the existing answer-level panel (reason
 * chips + textarea below). `layout="inline-right"` is a compact row variant
 * for sub-question / pivot rows: thumbs sit inline; on thumbs-down a small
 * text input appears immediately to the right (no reason chips), submitting
 * on Enter or blur. This is the literal "type feedback right next to the
 * icon" UX the user asked for.
 *
 * Hits POST /api/feedback. Optimistic local state — flips immediately, reverts
 * on a server failure.
 */

import { memo, useState, useCallback, useId } from "react";
import { ThumbsUp, ThumbsDown, X as XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  submitFeedback,
  type Feedback,
  type FeedbackReason,
  type FeedbackTarget,
} from "@/lib/api/feedback";

interface FeedbackButtonsProps {
  sessionId: string;
  turnId: string;
  /** Stored value from the server (loaded with the message). Defaults to "none". */
  initial?: Feedback;
  /** Stored comment from the server (per-target). */
  initialComment?: string;
  /** Granular target. Omitted → answer-level (legacy). */
  target?: FeedbackTarget;
  /** Layout variant. Default "block" (answer-level), "inline-right" for compact rows. */
  layout?: "block" | "inline-right";
  /** Read-only mode (e.g. superadmin shadow viewer) — renders state, blocks interaction. */
  disabled?: boolean;
}

const ICON_CLS = "h-3.5 w-3.5";

const REASON_LABELS: Record<FeedbackReason, string> = {
  vague: "Vague",
  wrong_numbers: "Wrong numbers",
  missing_context: "Missing context",
  too_long: "Too long",
  too_short: "Too short",
  format: "Bad format",
  other: "Other",
};

const REASON_ORDER: FeedbackReason[] = [
  "vague",
  "wrong_numbers",
  "missing_context",
  "too_long",
  "too_short",
  "format",
  "other",
];

function FeedbackButtonsImpl({
  sessionId,
  turnId,
  initial = "none",
  initialComment = "",
  target,
  layout = "block",
  disabled = false,
}: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<Feedback>(initial);
  const [pending, setPending] = useState<Feedback | null>(null);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReason[]>([]);
  const [comment, setComment] = useState(initialComment);
  const commentId = useId();
  const { toast } = useToast();

  const persist = useCallback(
    async (
      next: Feedback,
      reasons: FeedbackReason[] = [],
      commentText?: string
    ) => {
      const previous = feedback;
      setFeedback(next);
      setPending(next);
      const ok = await submitFeedback({
        sessionId,
        turnId,
        feedback: next,
        reasons: next === "down" ? reasons : undefined,
        comment: next === "down" && commentText?.trim() ? commentText.trim() : undefined,
        target,
      });
      setPending(null);
      if (!ok) {
        setFeedback(previous);
        toast({
          title: "Couldn't save feedback",
          description: "We'll keep your previous vote. Try again in a moment.",
          variant: "destructive",
        });
      }
      return ok;
    },
    [feedback, sessionId, turnId, target, toast]
  );

  const onThumbsUp = useCallback(async () => {
    if (disabled) return;
    const next: Feedback = feedback === "up" ? "none" : "up";
    setReasonsOpen(false);
    setSelectedReasons([]);
    setComment("");
    await persist(next);
  }, [feedback, persist, disabled]);

  const onThumbsDown = useCallback(async () => {
    if (disabled) return;
    if (feedback === "down") {
      setReasonsOpen(false);
      setSelectedReasons([]);
      setComment("");
      await persist("none");
      return;
    }
    setReasonsOpen(true);
    await persist("down", [], "");
  }, [feedback, persist, disabled]);

  const toggleReason = useCallback((r: FeedbackReason) => {
    setSelectedReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
    );
  }, []);

  const onSubmitReasons = useCallback(async () => {
    const ok = await persist("down", selectedReasons, comment);
    if (ok) {
      setReasonsOpen(false);
      toast({
        title: "Thanks for the detail",
        description: "We'll use it to improve the answer quality.",
      });
    }
  }, [persist, selectedReasons, comment, toast]);

  // Inline-right variant: persist the comment text on blur or Enter, no chips.
  const onInlineCommentCommit = useCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    await persist("down", [], trimmed);
  }, [persist, comment]);

  const upActive = feedback === "up";
  const downActive = feedback === "down";

  if (layout === "inline-right") {
    return (
      <div
        className="flex items-center gap-1"
        data-testid="feedback-buttons"
        data-target-type={target?.type ?? "answer"}
      >
        <Button
          type="button"
          size="sm"
          variant={upActive ? "default" : "ghost"}
          className="h-6 w-6 p-0"
          aria-label="Mark as helpful"
          aria-pressed={upActive}
          disabled={disabled || pending != null}
          onClick={() => void onThumbsUp()}
        >
          <ThumbsUp className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant={downActive ? "default" : "ghost"}
          className="h-6 w-6 p-0"
          aria-label="Mark as not helpful"
          aria-pressed={downActive}
          disabled={disabled || pending != null}
          onClick={() => void onThumbsDown()}
        >
          <ThumbsDown className="h-3 w-3" />
        </Button>
        {downActive && (
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 500))}
            onBlur={() => void onInlineCommentCommit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void onInlineCommentCommit();
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={disabled ? "" : "What's wrong?"}
            aria-label="Feedback comment"
            disabled={disabled}
            className="ml-1 h-6 rounded-md border border-border/60 bg-card px-2 text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40 w-44"
            maxLength={500}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mt-3" data-testid="feedback-buttons" data-target-type={target?.type ?? "answer"}>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant={upActive ? "default" : "ghost"}
          className="h-7 px-2"
          aria-label="Mark this answer as helpful"
          aria-pressed={upActive}
          disabled={disabled || pending != null}
          onClick={() => void onThumbsUp()}
        >
          <ThumbsUp className={ICON_CLS} />
        </Button>
        <Button
          type="button"
          size="sm"
          variant={downActive ? "default" : "ghost"}
          className="h-7 px-2"
          aria-label="Mark this answer as not helpful"
          aria-pressed={downActive}
          aria-expanded={reasonsOpen}
          aria-controls={`${commentId}-panel`}
          disabled={disabled || pending != null}
          onClick={() => void onThumbsDown()}
        >
          <ThumbsDown className={ICON_CLS} />
        </Button>
      </div>

      {reasonsOpen && !disabled && (
        <div
          id={`${commentId}-panel`}
          role="region"
          aria-label="Tell us what was wrong"
          className="mt-2 rounded-brand-md border border-border/60 bg-card p-3"
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <p className="text-xs font-semibold text-foreground">
              What was wrong? <span className="text-muted-foreground font-normal">(optional)</span>
            </p>
            <button
              type="button"
              onClick={() => setReasonsOpen(false)}
              aria-label="Close feedback details"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {REASON_ORDER.map((r) => {
              const active = selectedReasons.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => toggleReason(r)}
                  className={
                    active
                      ? "rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary"
                      : "rounded-full border border-border/60 bg-muted/20 px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  }
                  aria-pressed={active}
                >
                  {REASON_LABELS[r]}
                </button>
              );
            })}
          </div>
          {selectedReasons.includes("other") && (
            <Textarea
              id={commentId}
              value={comment}
              onChange={(e) => setComment(e.target.value.slice(0, 500))}
              placeholder="Tell us more (optional, ≤500 chars)"
              aria-label="Free-text feedback"
              className="min-h-[60px] text-sm mb-2"
              maxLength={500}
            />
          )}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setReasonsOpen(false)}
            >
              Skip
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={pending != null || (selectedReasons.length === 0 && !comment.trim())}
              onClick={() => void onSubmitReasons()}
            >
              Submit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export const FeedbackButtons = memo(FeedbackButtonsImpl);
