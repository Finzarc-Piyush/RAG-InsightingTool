import { useContext, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { dashboardsApi } from '@/lib/api';
import { DashboardContext } from '@/pages/Dashboard/context/DashboardContext';
import { getUserEmail } from '@/utils/userStorage';
import type { DashboardData } from '@/pages/Dashboard/modules/useDashboardState';
import type { DashboardPivotSpec } from '@/shared/schema';

interface AddPivotToDashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fully-built pivot snapshot to add. */
  pivot: DashboardPivotSpec;
}

/**
 * W9 · Slim modal mirroring DashboardModal.tsx for the pivot path.
 * Lets the user pick an existing dashboard (or create a new one) and pushes
 * the pivot via `dashboardsApi.addPivot`. Refetches the dashboard list on
 * success so subsequent clicks see the new dashboard immediately.
 */
export function AddPivotToDashboardModal({
  isOpen,
  onClose,
  pivot,
}: AddPivotToDashboardModalProps) {
  const ctx = useContext(DashboardContext);
  const { toast } = useToast();
  const [mode, setMode] = useState<'pick' | 'create'>('pick');
  const [selectedDashboardId, setSelectedDashboardId] = useState('');
  const [selectedSheetId, setSelectedSheetId] = useState('');
  const [newDashboardName, setNewDashboardName] = useState('');
  const [busy, setBusy] = useState(false);

  const editableDashboards = useMemo<DashboardData[]>(() => {
    if (!ctx) return [];
    const userEmail = getUserEmail()?.toLowerCase();
    return ctx.dashboards.filter((d) => {
      if (d.isShared) return d.sharedPermission === 'edit';
      return userEmail === d.username?.toLowerCase();
    });
  }, [ctx]);

  const selectedDashboard = useMemo(
    () => editableDashboards.find((d) => d.id === selectedDashboardId),
    [editableDashboards, selectedDashboardId]
  );
  const sheets =
    selectedDashboard?.sheets && selectedDashboard.sheets.length > 0
      ? selectedDashboard.sheets
      : selectedDashboard
        ? [
            {
              id: 'default',
              name: 'Overview',
              charts: selectedDashboard.charts ?? [],
              order: 0,
            },
          ]
        : [];

  if (!ctx) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dashboards unavailable</DialogTitle>
            <DialogDescription>
              Open the Dashboard page once to enable adding pivots from chat.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const handleAdd = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let dashboardId = selectedDashboardId;
      let sheetId = selectedSheetId || undefined;

      if (mode === 'create') {
        const name = newDashboardName.trim();
        if (!name) {
          toast({
            title: 'Name required',
            description: 'Pick a name for the new dashboard.',
            variant: 'destructive',
          });
          setBusy(false);
          return;
        }
        const created = await ctx.createDashboard(name);
        dashboardId = created.id;
        sheetId = undefined;
      }

      if (!dashboardId) {
        toast({
          title: 'Pick a dashboard',
          description: 'Select an existing dashboard or create a new one.',
          variant: 'destructive',
        });
        setBusy(false);
        return;
      }

      await dashboardsApi.addPivot(dashboardId, pivot, sheetId);
      await ctx.refetch();
      toast({
        title: 'Pivot added',
        description: `Added to ${
          mode === 'create' ? newDashboardName : selectedDashboard?.name
        }.`,
      });
      onClose();
    } catch (err: any) {
      toast({
        title: 'Could not add pivot',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add pivot to dashboard</DialogTitle>
          <DialogDescription>
            "{pivot.title}" will be added as a pivot tile.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'pick' ? 'default' : 'outline'}
              onClick={() => setMode('pick')}
            >
              Existing dashboard
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'create' ? 'default' : 'outline'}
              onClick={() => setMode('create')}
            >
              New dashboard
            </Button>
          </div>

          {mode === 'pick' ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Dashboard</Label>
                <select
                  className="mt-1 w-full rounded border border-border/60 bg-background px-2 py-2 text-sm"
                  value={selectedDashboardId}
                  onChange={(e) => {
                    setSelectedDashboardId(e.target.value);
                    setSelectedSheetId('');
                  }}
                >
                  <option value="">— Pick one —</option>
                  {editableDashboards.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              {sheets.length > 0 && (
                <div>
                  <Label className="text-xs">Sheet (optional)</Label>
                  <select
                    className="mt-1 w-full rounded border border-border/60 bg-background px-2 py-2 text-sm"
                    value={selectedSheetId}
                    onChange={(e) => setSelectedSheetId(e.target.value)}
                  >
                    <option value="">First sheet</option>
                    {sheets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ) : (
            <div>
              <Label className="text-xs">Dashboard name</Label>
              <Input
                className="mt-1"
                value={newDashboardName}
                onChange={(e) => setNewDashboardName(e.target.value)}
                placeholder="e.g. Sales drivers — March 2026"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding…
              </>
            ) : (
              'Add to Dashboard'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
