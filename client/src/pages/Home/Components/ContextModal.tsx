import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Info, Trash2 } from 'lucide-react';
import { sessionsApi } from '@/lib/api/sessions';
import type { UserDirective } from '@/shared/schema';

interface ContextModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (context: string) => Promise<void>;
  isLoading?: boolean;
  /**
   * When set, the modal switches into "append" mode: existing context is shown
   * read-only above the textarea, and any new input is appended (server-side
   * idempotent merge in `updateSessionPermanentContext`). Empty/undefined keeps
   * the original first-time copy.
   */
  existingContext?: string;
  /**
   * Wave W-UD9 · session id is required to fetch + revoke per-dataset
   * directives. When omitted (legacy callers), the Active Directives panel
   * is hidden.
   */
  sessionId?: string;
}

export function ContextModal({
  isOpen,
  onClose,
  onSave,
  isLoading = false,
  existingContext,
  sessionId,
}: ContextModalProps) {
  const [context, setContext] = useState('');
  const [directives, setDirectives] = useState<UserDirective[]>([]);
  const [directivesLoading, setDirectivesLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const hasExisting = !!existingContext && existingContext.trim().length > 0;

  // Reset textarea every time the modal opens so a prior draft doesn't leak
  // into the next "Give Additional Context" session.
  useEffect(() => {
    if (isOpen) setContext('');
  }, [isOpen]);

  // Wave W-UD9 · fetch active directives whenever the modal opens for a
  // session. Errors collapse to an empty list so the panel never blocks
  // the rest of the modal.
  useEffect(() => {
    if (!isOpen || !sessionId) {
      setDirectives([]);
      return;
    }
    let cancelled = false;
    setDirectivesLoading(true);
    sessionsApi
      .listDirectives(sessionId)
      .then((resp) => {
        if (cancelled) return;
        setDirectives(resp.activeDirectives ?? []);
      })
      .catch(() => {
        if (!cancelled) setDirectives([]);
      })
      .finally(() => {
        if (!cancelled) setDirectivesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionId]);

  const handleRevoke = async (directiveId: string) => {
    if (!sessionId) return;
    setRevokingId(directiveId);
    try {
      const resp = await sessionsApi.revokeDirective(sessionId, directiveId);
      setDirectives(resp.activeDirectives ?? []);
    } catch {
      // Best-effort — keep the row in the panel; the user can retry. The
      // server already preserves the audit trail.
    } finally {
      setRevokingId(null);
    }
  };

  const handleSave = async () => {
    if (context.trim()) {
      await onSave(context.trim());
    } else {
      // If empty, just close without saving
      onClose();
    }
  };

  const handleCancel = () => {
    setContext('');
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleCancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Info className="h-5 w-5" />
            {hasExisting ? 'Give Additional Context' : 'Add Context for Your Data'}
          </DialogTitle>
          <DialogDescription>
            {hasExisting
              ? 'Your existing context is shown below (read-only). Add more notes to refine how your data is interpreted — new notes are appended, not replaced.'
              : "Your data is loading in the background — tell us what you're trying to learn so we can tailor your starter questions. Your notes become part of this analysis permanently and are sent with every message. You can skip this step if you prefer."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {hasExisting && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Existing context
              </p>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                {existingContext}
              </div>
            </div>
          )}
          <div className="space-y-2">
            {hasExisting && (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Additional notes
              </p>
            )}
            <Textarea
              placeholder={
                hasExisting
                  ? 'E.g., Focus on Q4 promo periods. Treat any value above 100 as an outlier...'
                  : 'E.g., This data represents sales figures for Q4 2023. Focus on identifying trends and anomalies...'
              }
              value={context}
              onChange={(e) => setContext(e.target.value)}
              className="min-h-[120px] resize-none"
              disabled={isLoading}
            />
            <p className="text-sm text-muted-foreground">
              {hasExisting
                ? 'New notes are appended to your existing context, indexed for retrieval, and sent with every message.'
                : 'This context is saved permanently with this analysis, indexed for retrieval, and sent with every message.'}
            </p>
          </div>

          {sessionId && (
            <div className="space-y-2 border-t pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Active directives
              </p>
              {directivesLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : directives.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No persistent rules yet. Say things like “from now on omit Pure
                  Sense from any brand breakdown” mid-chat to add one.
                </p>
              ) : (
                <ul className="space-y-2">
                  {directives.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 p-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="break-words text-sm">{d.text}</div>
                        {d.structured?.column && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {d.structured.column}
                            {' '}
                            {d.structured.op}
                            {' '}
                            {(d.structured.values ?? []).join(', ')}
                          </div>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0"
                        disabled={revokingId === d.id}
                        onClick={() => handleRevoke(d.id)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        {revokingId === d.id ? 'Revoking…' : 'Revoke'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isLoading}
          >
            {hasExisting ? 'Cancel' : 'Skip'}
          </Button>
          <Button
            onClick={handleSave}
            disabled={isLoading}
          >
            {isLoading
              ? 'Saving...'
              : hasExisting
                ? 'Append Context'
                : 'Save Context'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
