/**
 * Wave A13 · Right-side sheet listing the user's saved Automations.
 *
 * Opens from the StartAnalysisView 3rd card. User picks one → onPick
 * fires with the chosen automation summary, and the parent advances
 * to "now choose your data source" with the picked automation pinned.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Repeat, Search, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { automationsApi } from "@/lib/api";
import type { AutomationSummary } from "@/shared/schema";

export interface AutomationPickerSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (automation: AutomationSummary) => void;
}

const formatDate = (iso: string | undefined): string => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
};

export const AutomationPickerSheet = ({
  open,
  onOpenChange,
  onPick,
}: AutomationPickerSheetProps) => {
  const { toast } = useToast();
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    automationsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        setAutomations(res.automations ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        toast({
          title: "Could not load automations",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, toast]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return automations;
    return automations.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.sourceFileName.toLowerCase().includes(q)
    );
  }, [automations, search]);

  const handleDelete = async (id: string, name: string) => {
    if (
      !confirm(`Delete automation "${name}"? This cannot be undone.`)
    )
      return;
    setDeletingId(id);
    try {
      await automationsApi.remove(id);
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      toast({
        title: "Automation deleted",
        description: name,
      });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 flex flex-col"
      >
        <SheetHeader className="border-b border-border/80 p-4">
          <div className="flex items-center gap-2">
            <Repeat className="h-5 w-5" />
            <SheetTitle>Run an Automation</SheetTitle>
          </div>
          <SheetDescription>
            Pick a saved chat to replay against a new dataset. After you
            choose, you'll select the data source (Excel or Snowflake).
          </SheetDescription>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search automations…"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading automations…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {search.trim()
                ? "No automations match your search."
                : "You haven't saved any automations yet. Open a chat, ask some questions, then click Save as Automation."}
            </div>
          ) : (
            <ul className="space-y-3">
              {filtered.map((a) => (
                <li
                  key={a.id}
                  className="rounded-lg border border-border bg-card p-4 hover:border-primary/60 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onPick(a)}
                      className="flex-1 text-left"
                    >
                      <div className="font-medium text-foreground">
                        {a.name}
                      </div>
                      {a.description && (
                        <div className="mt-1 text-sm text-muted-foreground line-clamp-2">
                          {a.description}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <Badge variant="outline" className="font-normal">
                          {a.recipeLength} question
                          {a.recipeLength === 1 ? "" : "s"}
                        </Badge>
                        <Badge variant="outline" className="font-normal">
                          {a.expectedColumnCount} column
                          {a.expectedColumnCount === 1 ? "" : "s"}
                        </Badge>
                        <span>·</span>
                        <span title={a.sourceFileName}>
                          {a.sourceFileName.length > 32
                            ? a.sourceFileName.slice(0, 30) + "…"
                            : a.sourceFileName}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Created {formatDate(a.createdAt)}
                        {a.lastRunAt &&
                          ` · last run ${formatDate(a.lastRunAt)}`}
                        {a.runCount > 0 && ` · ${a.runCount} run${a.runCount === 1 ? "" : "s"}`}
                      </div>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(a.id, a.name)}
                      disabled={deletingId === a.id}
                      title="Delete this automation"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {deletingId === a.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};
