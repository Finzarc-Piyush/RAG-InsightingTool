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
import { Info } from 'lucide-react';

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
}

export function ContextModal({
  isOpen,
  onClose,
  onSave,
  isLoading = false,
  existingContext,
}: ContextModalProps) {
  const [context, setContext] = useState('');

  const hasExisting = !!existingContext && existingContext.trim().length > 0;

  // Reset textarea every time the modal opens so a prior draft doesn't leak
  // into the next "Give Additional Context" session.
  useEffect(() => {
    if (isOpen) setContext('');
  }, [isOpen]);

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
