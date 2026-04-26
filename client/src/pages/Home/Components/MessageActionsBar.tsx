/**
 * W7 · MessageActionsBar
 *
 * Inline icon row attached to assistant messages: Copy, (Regenerate placeholder
 * — wired in W9), (Share placeholder). Patterned after Claude.ai / ChatGPT.
 *
 * Visible only for assistant messages with non-empty content. Uses semantic
 * tokens (per client/THEMING.md). Each button has an aria-label so screen
 * readers announce the action.
 */
import { useState } from "react";
import type { Message } from "@/shared/schema";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { copyAnswerToClipboard } from "@/lib/chat/copyAnswer";
import { useToast } from "@/hooks/use-toast";
import { RegenerateButton } from "./RegenerateButton";

interface MessageActionsBarProps {
  message: Message;
  /** The user question that produced this assistant message; powers the W9 Regenerate dropdown. */
  precedingUserQuestion?: string;
}

export function MessageActionsBar({ message, precedingUserQuestion }: MessageActionsBarProps) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  if (message.role !== "assistant") return null;
  const hasContent = !!(message.content?.trim() || message.answerEnvelope);
  if (!hasContent) return null;

  const onCopy = async () => {
    const ok = await copyAnswerToClipboard(message);
    if (ok) {
      setCopied(true);
      // Reset the icon after 2s — short enough that rapid copies feel responsive,
      // long enough for the user to see the confirmation.
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: "Copied to clipboard",
        description: "The answer is now on your clipboard as markdown.",
      });
    } else {
      toast({
        title: "Copy failed",
        description: "Your browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="mt-3 flex items-center gap-1 border-t border-border/40 pt-2"
      role="toolbar"
      aria-label="Message actions"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={onCopy}
        aria-label={copied ? "Answer copied" : "Copy answer to clipboard"}
      >
        {copied ? (
          <>
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Copy
          </>
        )}
      </Button>
      {precedingUserQuestion && (
        <RegenerateButton originalQuestion={precedingUserQuestion} />
      )}
    </div>
  );
}
