import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';

interface EditTableCaptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (caption: string) => Promise<void>;
  title: string;
  initialCaption: string;
  isLoading?: boolean;
}

export function EditTableCaptionModal({
  isOpen,
  onClose,
  onSave,
  title,
  initialCaption,
  isLoading = false,
}: EditTableCaptionModalProps) {
  const [caption, setCaption] = useState(initialCaption);

  React.useEffect(() => {
    if (isOpen) setCaption(initialCaption);
  }, [isOpen, initialCaption]);

  const handleCancel = () => {
    setCaption(initialCaption);
    onClose();
  };

  const handleSave = async () => {
    const next = caption.trim();
    if (!next) return;
    await onSave(next);
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Edit {title}</DialogTitle>
          <DialogDescription>Give this table a clear, descriptive caption.</DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-2">
          <Input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Enter table caption..."
            disabled={isLoading}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading || !caption.trim()}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'OK'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

