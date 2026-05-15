/**
 * Wave A10 · Save-as-Automation modal.
 *
 * Triggered from the chat-surface "Save as Automation" button. Posts to
 * `POST /api/automations` with `{sessionId, name, description?}`. On
 * success, surfaces a brief stats line ("Captured 12 questions, 4 charts,
 * 2 dashboards") and closes.
 *
 * Defaults the name to `<sourceFileName> · automation · <YYYY-MM-DD>`.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save } from "lucide-react";
import { automationsApi } from "@/lib/api";

export interface SaveAutomationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  fileName: string;
  /** Pre-flight stats shown in the dialog body before the user submits. */
  preview: {
    questionCount: number;
    chartCount: number;
    dashboardCount: number;
  };
  /** Callback invoked with `{id, name}` on successful create. */
  onCreated?: (created: { id: string; name: string }) => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const defaultName = (fileName: string) => {
  const stem = fileName.replace(/\.[a-zA-Z0-9]+$/, "");
  return `${stem} · automation · ${todayIso()}`.slice(0, 120);
};

export const SaveAutomationModal = ({
  open,
  onOpenChange,
  sessionId,
  fileName,
  preview,
  onCreated,
}: SaveAutomationModalProps) => {
  const { toast } = useToast();
  const [name, setName] = useState(defaultName(fileName));
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName(fileName));
      setDescription("");
    }
  }, [open, fileName]);

  const trimmedName = name.trim();
  const canSubmit =
    trimmedName.length >= 1 &&
    trimmedName.length <= 120 &&
    !submitting &&
    preview.questionCount > 0;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await automationsApi.create(
        sessionId,
        trimmedName,
        description.trim() || undefined
      );
      toast({
        title: "Automation saved",
        description: `Captured ${preview.questionCount} questions, ${preview.chartCount} charts, ${preview.dashboardCount} dashboards.`,
      });
      onCreated?.({ id: res.id, name: res.name });
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not save the automation.";
      toast({
        title: "Save failed",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="h-5 w-5" />
            Save chat as Automation
          </DialogTitle>
          <DialogDescription>
            Capture every question and step from this chat as a re-runnable
            automation. You can run it later against a fresh dataset with the
            same column structure.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marico-VN Q3 review"
              maxLength={120}
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="automation-description">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="automation-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this automation does, who it's for, what data shape it expects."
              rows={3}
              maxLength={1000}
              disabled={submitting}
            />
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {preview.questionCount === 0 ? (
              <span>
                This chat has no completed questions yet. Ask at least one
                question and wait for the answer before saving.
              </span>
            ) : (
              <span>
                Will capture <strong>{preview.questionCount}</strong> question
                {preview.questionCount === 1 ? "" : "s"},{" "}
                <strong>{preview.chartCount}</strong> chart
                {preview.chartCount === 1 ? "" : "s"}, and{" "}
                <strong>{preview.dashboardCount}</strong> dashboard
                {preview.dashboardCount === 1 ? "" : "s"}.
              </span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {submitting ? "Saving…" : "Save automation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
