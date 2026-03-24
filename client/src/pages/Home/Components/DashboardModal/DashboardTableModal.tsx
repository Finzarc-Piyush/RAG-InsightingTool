import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Table2 } from 'lucide-react';
import { DashboardTableSpec } from '@/shared/schema';
import { DashboardContext } from '@/pages/Dashboard/context/DashboardContext';
import { useToast } from '@/hooks/use-toast';
import { getUserEmail } from '@/utils/userStorage';
import { DashboardData } from '@/pages/Dashboard/modules/useDashboardState';

interface DashboardTableModalProps {
  isOpen: boolean;
  onClose: () => void;
  table: DashboardTableSpec;
}

type Step = 'select' | 'confirm';

type DestinationMode = 'existing' | 'new';

export function DashboardTableModal({ isOpen, onClose, table }: DashboardTableModalProps) {
  const { toast } = useToast();

  // Safely get context - don't throw error if not available
  const contextValue = useContext(DashboardContext);
  if (!contextValue) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-2xl w-full">
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="text-sm text-muted-foreground">
              Dashboard functionality is not available. Please navigate to the Dashboard page first.
            </p>
            <Button variant="outline" onClick={onClose} className="mt-4">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const {
    dashboards,
    createDashboard,
    addTableToDashboard,
    addSheet,
    refetch,
  } = contextValue;

  const [step, setStep] = useState<Step>('select');
  const [destinationMode, setDestinationMode] = useState<DestinationMode>('existing');
  const [selectedDashboardId, setSelectedDashboardId] = useState<string>('');
  const [newDashboardName, setNewDashboardName] = useState('');
  const [selectedSheetId, setSelectedSheetId] = useState<string>('');
  const [createNewSheet, setCreateNewSheet] = useState(false);
  const [newSheetName, setNewSheetName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Default sheet creation for dashboards that don't have sheets yet (backward compatibility)
  const getDashboardSheets = (dashboard: DashboardData) => {
    if (dashboard.sheets && dashboard.sheets.length > 0) return dashboard.sheets;
    return [{ id: 'default', name: 'Overview', charts: dashboard.charts, tables: [], order: 0 }];
  };

  const editableDashboards = useMemo(() => {
    const userEmail = getUserEmail()?.toLowerCase();
    return dashboards.filter((dashboard) => {
      if (!userEmail) return false;
      if (dashboard.isShared) {
        return dashboard.sharedPermission === 'edit';
      }
      const dashboardUsername = dashboard.username?.toLowerCase();
      return userEmail === dashboardUsername;
    });
  }, [dashboards]);

  const selectedDashboard = useMemo(
    () => editableDashboards.find((d) => d.id === selectedDashboardId) || null,
    [editableDashboards, selectedDashboardId]
  );

  const sheetOptions = useMemo(() => {
    if (!selectedDashboard) return [];
    return getDashboardSheets(selectedDashboard);
  }, [selectedDashboard]);

  useEffect(() => {
    if (!isOpen) return;

    setStep('select');
    setDestinationMode('existing');
    setSelectedDashboardId(editableDashboards[0]?.id || '');
    setSelectedSheetId('');
    setNewDashboardName('');
    setCreateNewSheet(false);
    setNewSheetName('');
    setIsSaving(false);
  }, [isOpen, editableDashboards]);

  useEffect(() => {
    if (!selectedDashboard) return;
    const sheets = getDashboardSheets(selectedDashboard);
    if (!sheets.length) return;

    if (!selectedSheetId || !sheets.some((s) => s.id === selectedSheetId)) {
      setSelectedSheetId(sheets[0].id);
    }
  }, [selectedDashboard, selectedSheetId]);

  const resetAndClose = () => {
    if (isSaving) return;
    onClose();
  };

  const handleConfirm = async () => {
    try {
      setIsSaving(true);

      // Create new dashboard, if selected
      let finalDashboardId = selectedDashboardId;
      let finalSheetId = selectedSheetId || 'default';

      if (destinationMode === 'new') {
        const created = await createDashboard(newDashboardName.trim());
        finalDashboardId = created.id;

        // If the user also wants a new sheet inside the new dashboard
        if (createNewSheet && newSheetName.trim()) {
          const updated = await addSheet(created.id, newSheetName.trim());
          const createdSheet =
            updated.sheets?.find((s) => s.name.toLowerCase().trim() === newSheetName.trim().toLowerCase()) ||
            updated.sheets?.[updated.sheets.length - 1];

          finalSheetId = createdSheet?.id || 'default';
        } else {
          finalSheetId = updatedDefaultSheetId(created) || 'default';
        }
      } else {
        // Existing dashboard
        if (createNewSheet && newSheetName.trim()) {
          const updated = await addSheet(selectedDashboardId, newSheetName.trim());
          const createdSheet =
            updated.sheets?.find((s) => s.name.toLowerCase().trim() === newSheetName.trim().toLowerCase()) ||
            updated.sheets?.[updated.sheets.length - 1];
          finalSheetId = createdSheet?.id || selectedSheetId || 'default';
        } else {
          finalSheetId = selectedSheetId || sheetOptions[0]?.id || 'default';
        }
      }

      await addTableToDashboard(finalDashboardId, table, finalSheetId);
      toast({
        title: 'Success',
        description: 'Table added to dashboard successfully.',
      });
      await refetch();
      resetAndClose();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error?.message || 'Failed to add table to dashboard',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
      setStep('select');
    }
  };

  const updatedDefaultSheetId = (created: any): string | null => {
    // In this codebase the default sheet id is typically `default` for legacy reasons.
    if (created?.sheets?.length) return created.sheets[0].id;
    return 'default';
  };

  return (
    <Dialog open={isOpen} onOpenChange={resetAndClose}>
      <DialogContent className="sm:max-w-2xl w-full max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="h-5 w-5" />
            Add Table to Dashboard
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Card className="border-0">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <Table2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-medium">{table.caption}</h3>
                  <p className="text-sm text-muted-foreground">
                    {table.columns.length} columns, {table.rows.length} rows
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {step === 'select' ? (
            <>
              <div className="space-y-2">
                <Label className="text-sm font-medium">Where to add this table</Label>
                <RadioGroup value={destinationMode} onValueChange={(v) => setDestinationMode(v as DestinationMode)}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="existing" id="dest-existing" />
                    <Label htmlFor="dest-existing">Existing dashboard</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="new" id="dest-new" />
                    <Label htmlFor="dest-new">Create a new dashboard</Label>
                  </div>
                </RadioGroup>
              </div>

              {destinationMode === 'existing' && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Dashboard</Label>
                  <Select value={selectedDashboardId} onValueChange={setSelectedDashboardId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select dashboard" />
                    </SelectTrigger>
                    <SelectContent>
                      {editableDashboards.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {sheetOptions.length > 0 && (
                    <div className="space-y-2 pt-2">
                      <Label className="text-sm font-medium">Sheet</Label>
                      <Select value={selectedSheetId} onValueChange={setSelectedSheetId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select sheet" />
                        </SelectTrigger>
                        <SelectContent>
                          {sheetOptions.map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              {destinationMode === 'new' && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">New dashboard name</Label>
                  <Input
                    value={newDashboardName}
                    onChange={(e) => setNewDashboardName(e.target.value)}
                    placeholder="e.g., GoBro Sales"
                  />
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={createNewSheet}
                    onChange={(e) => setCreateNewSheet(e.target.checked)}
                  />
                  <Label className="text-sm font-medium">Create a new sheet</Label>
                </div>
                {createNewSheet && (
                  <Input
                    value={newSheetName}
                    onChange={(e) => setNewSheetName(e.target.value)}
                    placeholder="Sheet name"
                  />
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={onClose} disabled={isSaving}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    isSaving ||
                    (destinationMode === 'existing' && !selectedDashboardId) ||
                    (destinationMode === 'new' && !newDashboardName.trim()) ||
                    (createNewSheet && !newSheetName.trim())
                  }
                  onClick={() => setStep('confirm')}
                >
                  Next
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                You are about to add the following table to your dashboard.
              </p>
              <div className="rounded-lg border bg-background p-4 space-y-2">
                <div className="text-sm font-medium">{table.caption}</div>
                <div className="text-xs text-muted-foreground">
                  {destinationMode === 'new' ? `New dashboard: ${newDashboardName.trim()}` : `Dashboard: ${editableDashboards.find((d) => d.id === selectedDashboardId)?.name || selectedDashboardId}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  Sheet: {createNewSheet ? newSheetName.trim() : sheetOptions.find((s) => s.id === selectedSheetId)?.name || selectedSheetId}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setStep('select')} disabled={isSaving}>
                  Back
                </Button>
                <Button onClick={handleConfirm} disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    'Add'
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

