import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { automationsApi } from "@/lib/api";
import type { Automation, AutomationStep } from "@/shared/schema";
import type { Message } from "@/shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, GripVertical } from "lucide-react";

// All steps are chat messages – no separation between data ops and analysis
function newMessageStep(): AutomationStep {
  return { type: "message", userMessage: "" };
}

interface AutomationsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current chat messages; when modal opens, steps are pre-filled with all user messages up to this point */
  chatMessages?: Message[];
}

export function AutomationsModal({ open, onOpenChange, chatMessages = [] }: AutomationsModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newSteps, setNewSteps] = useState<AutomationStep[]>([]);
  const wasOpenRef = useRef(false);

  // When modal opens, pre-fill steps with all user messages from the chat so far
  useEffect(() => {
    if (open && chatMessages.length > 0) {
      const userMessages = chatMessages.filter((m) => m.role === "user" && m.content?.trim());
      if (userMessages.length > 0 && !wasOpenRef.current) {
        const stepsFromChat: AutomationStep[] = userMessages.map((m) => ({
          type: "message",
          userMessage: (m.content || "").trim(),
        }));
        setNewSteps(stepsFromChat);
      }
      wasOpenRef.current = true;
    } else {
      wasOpenRef.current = false;
    }
  }, [open, chatMessages]);

  const { data, isLoading } = useQuery({
    queryKey: ["automations"],
    queryFn: () => automationsApi.list(),
    enabled: open,
  });
  const automations = data?.automations ?? [];

  const addStep = () => {
    setNewSteps((prev) => [...prev, newMessageStep()]);
  };

  const updateStep = (index: number, step: AutomationStep) => {
    setNewSteps((prev) => {
      const next = [...prev];
      next[index] = step;
      return next;
    });
  };

  const removeStep = (index: number) => {
    setNewSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    // All steps are chat messages
    const stepsToSave: AutomationStep[] = (newSteps.length ? newSteps : [newMessageStep()])
      .filter((s): s is AutomationStep & { type: "message" } => s.type === "message")
      .map((s) => ({ type: "message" as const, userMessage: (s.userMessage || "").trim() }))
      .filter((s) => s.userMessage.length > 0);
    if (stepsToSave.length === 0) {
      toast({ title: "Add at least one step with text", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      await automationsApi.create({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
        steps: stepsToSave,
      });
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      setNewName("");
      setNewDescription("");
      setNewSteps([]);
      toast({ title: "Automation created" });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to create automation",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await automationsApi.remove(id);
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast({ title: "Automation deleted" });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err?.message || "Failed to delete",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl h-[85vh] flex flex-col p-6 gap-4 overflow-hidden"
        onCloseAutoFocus={(e) => {
          // Prevent focus returning to the Automations dropdown trigger when closing.
          e.preventDefault();
        }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Automations</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground flex-shrink-0">
          Run a saved sequence of data operations and dashboard steps when you upload or load data.
        </p>

        {/* List */}
        <div className="space-y-2 flex-shrink-0">
          <Label>Saved automations</Label>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading...
            </div>
          ) : automations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No automations yet. Create one below.</p>
          ) : (
            <ul className="space-y-2 max-h-[120px] overflow-y-auto">
              {automations.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border bg-card px-3 py-2 text-sm"
                >
                  <div>
                    <span className="font-medium">{a.name}</span>
                    {a.description && (
                      <span className="ml-2 text-muted-foreground">{a.description}</span>
                    )}
                    {a.steps?.length > 0 && (
                      <span className="ml-2 text-muted-foreground">({a.steps.length} steps)</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(a.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Create new - scrollable form with Save button always visible at bottom */}
        <div className="flex flex-col flex-1 min-h-0 border-t pt-4 overflow-hidden">
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
            <Label className="flex-shrink-0">Create automation</Label>
            <div className="grid gap-2">
              <div>
                <Label className="text-xs">Name</Label>
                <Input
                  placeholder="e.g. Clean data and create report"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Description (optional)</Label>
                <Input
                  placeholder="Short description"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mt-2">
                  <Label className="text-xs">Steps (run in order)</Label>
                  <Button type="button" variant="outline" size="sm" onClick={addStep}>
                    <Plus className="w-4 h-4 mr-1" />
                    Add step
                  </Button>
                </div>
                {newSteps.length === 0 ? (
                  <p className="text-sm text-muted-foreground mt-1">
                    No steps yet. Add steps from chat above, or click &quot;Add step&quot; to add a message.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {newSteps.map((step, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2 rounded-lg border bg-muted/30 p-2 text-sm"
                      >
                        <GripVertical className="w-4 h-4 mt-1 text-muted-foreground flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          {step.type === "message" ? (
                            <textarea
                              className="w-full min-h-[80px] rounded-md border bg-background px-2 py-1.5 text-sm"
                              placeholder="e.g. correlation of PA TOM with all the other variables"
                              value={step.userMessage}
                              onChange={(e) =>
                                updateStep(idx, { ...step, userMessage: e.target.value })
                              }
                            />
                          ) : (
                            <span className="text-muted-foreground text-xs">(Unsupported step type)</span>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 flex-shrink-0"
                          onClick={() => removeStep(idx)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
          <div className="flex-shrink-0 pt-3 border-t mt-2">
            <Button
              type="button"
              className="w-full sm:w-auto"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save automation
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
