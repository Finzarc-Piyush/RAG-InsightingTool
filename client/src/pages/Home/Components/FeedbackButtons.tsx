/**
 * W5.5b · Thumbs up/down on a completed assistant turn.
 * W9 · Adds reason chips + free-text comment after thumbs-down so the team
 *      can slice "what went wrong" by category, not just count negative votes.
 *
 * Hits POST /api/feedback. Optimistic local state — flips immediately, reverts
 * on a server failure. The server uses the value to:
 *   - exclude this past-analysis row from the W5 cache (`feedback ne 'down'`)
 *   - feed the W3.11 golden-question seeder (curated thumbs-up corpus)
 *   - aggregate reasons in the admin /admin/costs view
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
} from "@/lib/api/feedback";

interface FeedbackButtonsProps {
  sessionId: string;
  turnId: string;
  /** Stored value from the server (loaded with the message). Defaults to "none". */
  initial?: Feedback;
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
}: FeedbackButtonsProps) {
  const [feedback, setFeedback] = useState<Feedback>(initial);
  const [pending, setPending] = useState<Feedback | null>(null);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [selectedReasons, setSelectedReasons] = useState<FeedbackReason[]>([]);
  const [comment, setComment] = useState("");
  const commentId = useId();
  const { toast } = useToast();

  const persist = useCallback(
    async (
      target: Feedback,
      reasons: FeedbackReason[] = [],
      commentText?: string
    ) => {
      const previous = feedback;
      setFeedback(target);
      setPending(target);
      const ok = await submitFeedback({
        sessionId,
        turnId,
        feedback: target,
        reasons: target === "down" ? reasons : undefined,
        comment: target === "down" && commentText?.trim() ? commentText.trim() : undefined,
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
    [feedback, sessionId, turnId, toast]
  );

  const onThumbsUp = useCallback(async () => {
    const target: Feedback = feedback === "up" ? "none" : "up";
    setReasonsOpen(false);
    setSelectedReasons([]);
    setComment("");
    await persist(target);
  }, [feedback, persist]);

  const onThumbsDown = useCallback(async () => {
    if (feedback === "down") {
      // Toggle off — clears reasons too.
      setReasonsOpen(false);
      setSelectedReasons([]);
      setComment("");
      await persist("none");
      return;
    }
    // First click: persist the down-vote immediately so the cache is invalidated
    // even if the user never picks a reason. Then open the reasons popover.
    setReasonsOpen(true);
    await persist("down", [], "");
  }, [feedback, persist]);

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

  const upActive = feedback === "up";
  const downActive = feedback === "down";

  return (
    <div className="mt-3" data-testid="feedback-buttons">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant={upActive ? "default" : "ghost"}
          className="h-7 px-2"
          aria-label="Mark this answer as helpful"
          aria-pressed={upActive}
          disabled={pending != null}
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
          disabled={pending != null}
          onClick={() => void onThumbsDown()}
        >
          <ThumbsDown className={ICON_CLS} />
        </Button>
      </div>

      {reasonsOpen && (
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
