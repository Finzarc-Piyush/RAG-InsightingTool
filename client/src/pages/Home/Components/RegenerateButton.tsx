/**
 * W9 · RegenerateButton
 *
 * Dropdown menu attached to assistant messages: Regenerate, Longer, Shorter,
 * More technical, Less technical. Each selection dispatches a custom event the
 * chat host listens for. Decoupled via CustomEvent so the wiring (rewind
 * history, re-fire submit) is the host's concern — not the bubble's — and we
 * can ship the UI today before the host integration lands.
 *
 * Event:
 *   name:   "rag:regenerate"
 *   detail: { originalQuestion: string; constraint?: RegenerateConstraint }
 *
 * The constraint, when present, should be prepended to the user's question
 * before re-firing the chat stream — e.g. "Make this longer: <question>".
 */
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RefreshCw } from "lucide-react";
import {
  buildRegenerateQuestion,
  REGENERATE_EVENT,
  type RegenerateConstraint,
  type RegenerateEventDetail,
} from "@/lib/chat/regeneratePrompt";

export type { RegenerateConstraint, RegenerateEventDetail } from "@/lib/chat/regeneratePrompt";
export { REGENERATE_EVENT, buildRegenerateQuestion } from "@/lib/chat/regeneratePrompt";

interface RegenerateButtonProps {
  /** The user message that produced the assistant answer; required to rebuild. */
  originalQuestion: string;
}

export function RegenerateButton({ originalQuestion }: RegenerateButtonProps) {
  const fire = useCallback(
    (constraint: RegenerateConstraint) => {
      const detail: RegenerateEventDetail = {
        originalQuestion,
        constraint,
        questionToSubmit: buildRegenerateQuestion(originalQuestion, constraint),
      };
      window.dispatchEvent(new CustomEvent<RegenerateEventDetail>(REGENERATE_EVENT, { detail }));
    },
    [originalQuestion]
  );

  if (!originalQuestion) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Regenerate this answer with optional constraints"
        >
          <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Regenerate
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => fire("default")}>
          Regenerate
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
          With a tweak
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => fire("longer")}>
          Make it longer
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => fire("shorter")}>
          Make it shorter
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => fire("more_technical")}>
          More technical
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => fire("less_technical")}>
          Less technical
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
