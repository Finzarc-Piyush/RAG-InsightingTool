import React, { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDashboardContext } from './context/DashboardContext';
import { DashboardData } from './modules/useDashboardState';
import { DashboardList } from './Components/DashboardList';
import { DashboardView } from './Components/DashboardView';
import { DeleteDashboardDialog } from './Components/DeleteDashboardDialog';
import { PendingInvitesBanner } from './Components/PendingInvitesBanner';
import { Dashboard as ServerDashboard } from '@/shared/schema';
import { normalizeDashboard } from './modules/useDashboardState';

export default function Dashboard() {
  const queryClient = useQueryClient();
  const {
    dashboards,
    currentDashboard,
    setCurrentDashboard,
    createDashboard,
    deleteDashboard,
    removeChartFromDashboard,
    removeTableFromDashboard,
    fetchDashboardById,
    status,
    refetch,
  } = useDashboardContext();

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [dashboardToDelete, setDashboardToDelete] = useState<string | null>(null);
  const openedFromQueryRef = useRef<string | null>(null);

  useEffect(() => {
    const openId = new URLSearchParams(window.location.search).get('open');
    if (!openId) return;
    if (openedFromQueryRef.current === openId) return;

    void (async () => {
      const listDash = dashboards.find((d) => d.id === openId);
      try {
        const fresh = await fetchDashboardById(openId);
        openedFromQueryRef.current = openId;
        setCurrentDashboard({
          ...fresh,
          isShared: listDash?.isShared ?? fresh.isShared,
          sharedPermission: listDash?.sharedPermission ?? fresh.sharedPermission,
          sharedBy: listDash?.sharedBy ?? fresh.sharedBy,
          permission: listDash?.permission ?? fresh.permission ?? fresh.sharedPermission,
          collaborators: fresh.collaborators ?? listDash?.collaborators,
          hasCollaborators: fresh.hasCollaborators ?? listDash?.hasCollaborators,
        });
      } catch (e) {
        console.error('Deep-link dashboard open failed:', e);
        return;
      }
      window.history.replaceState({}, '', '/dashboard');
    })();
  }, [dashboards, fetchDashboardById]);

  const handleViewDashboard = async (dashboard: DashboardData) => {
    // Fetch fresh dashboard data to get updated lastOpenedAt
    try {
      const freshDashboard = await fetchDashboardById(dashboard.id);
      // Preserve permission and shared status if it's a shared dashboard
      const dashboardWithPermission = {
        ...freshDashboard,
        isShared: dashboard.isShared,
        sharedPermission: dashboard.sharedPermission,
        sharedBy: dashboard.sharedBy,
        permission: dashboard.permission || dashboard.sharedPermission,
        collaborators: freshDashboard.collaborators || dashboard.collaborators,
        hasCollaborators: freshDashboard.hasCollaborators || dashboard.hasCollaborators,
      };
      setCurrentDashboard(dashboardWithPermission);
    } catch (error) {
      // Fallback to cached dashboard if fetch fails
      console.error('Failed to fetch dashboard:', error);
      setCurrentDashboard(dashboard);
    }
  };

  const handleBackToList = () => {
    setCurrentDashboard(null);
  };

  const handleDeleteClick = (dashboardId: string) => {
    setDashboardToDelete(dashboardId);
    setDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (dashboardToDelete) {
      await deleteDashboard(dashboardToDelete);
      setDeleteConfirmOpen(false);
      setDashboardToDelete(null);
    }
  };

  const handleDeleteChart = async (chartIndex: number, sheetId?: string) => {
    console.log('Delete chart clicked:', { chartIndex, sheetId, currentDashboard: currentDashboard?.id });
    if (currentDashboard) {
      console.log('Proceeding with chart deletion');
      const updatedDashboard = await removeChartFromDashboard(currentDashboard.id, chartIndex, sheetId);
      setCurrentDashboard(updatedDashboard);
      await refetch();
    }
  };

  const handleDeleteTable = async (tableIndex: number, sheetId?: string) => {
    if (currentDashboard) {
      const updatedDashboard = await removeTableFromDashboard(currentDashboard.id, tableIndex, sheetId);
      setCurrentDashboard(updatedDashboard);
      await refetch();
    }
  };

  const handleSharedDashboardAccepted = async (data: { invite: any; dashboard: ServerDashboard }) => {
    try {
      // Normalize the dashboard data first
      const normalizedDashboard = normalizeDashboard({
        ...data.dashboard,
        isShared: true,
        sharedPermission: data.invite.permission,
        sharedBy: data.invite.ownerEmail,
      });
      // Set the permission based on the invite
      const dashboardWithPermission = {
        ...normalizedDashboard,
        permission: data.invite.permission as "view" | "edit",
      };
      
      // Immediately add to the cache so it appears in the list right away
      queryClient.setQueryData<DashboardData[]>(['dashboards', 'list'], (prev) => {
        const existing = prev ?? [];
        // Check if dashboard already exists
        const exists = existing.some(d => d.id === dashboardWithPermission.id);
        if (exists) {
          // Update existing dashboard
          return existing.map(d => d.id === dashboardWithPermission.id ? dashboardWithPermission : d);
        }
        // Add new shared dashboard
        return [...existing, dashboardWithPermission];
      });
      
      // Also invalidate and refetch to ensure we have the latest data from backend
      setTimeout(async () => {
        await queryClient.invalidateQueries({ queryKey: ['dashboards', 'list'] });
        await refetch();
      }, 500);
      
      setCurrentDashboard(dashboardWithPermission);
    } catch (error) {
      console.error('Failed to load shared dashboard:', error);
      // Still try to refetch even if there's an error
      await queryClient.invalidateQueries({ queryKey: ['dashboards', 'list'] });
      await refetch();
    }
  };

  // DR16 · `handleViewSharedDashboard` removed alongside the
  // `SharedDashboardsPanel`. Accepted shared dashboards are now in the
  // main grid (filterable via the Owned/Shared toggle) and clicking
  // their View button routes through `handleViewDashboard` like any
  // other dashboard. The shared metadata (`isShared`, `sharedPermission`,
  // `sharedBy`) is already on the cached `DashboardData` so the
  // permission-aware UI inside `DashboardView` continues to work.

  if (currentDashboard) {
    return (
      <DashboardView
        dashboard={currentDashboard}
        onBack={handleBackToList}
        onDeleteChart={handleDeleteChart}
        onDeleteTable={handleDeleteTable}
        isRefreshing={status.refreshing}
        onRefresh={refetch}
      />
    );
  }

  const dashboardToDeleteName = dashboardToDelete
    ? dashboards.find((d) => d.id === dashboardToDelete)?.name
    : null;

  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    setDashboardToDelete(null);
  };

  return (
    <>
      {/* DR16 · single full-width column. The pre-DR16 384-px shared-
          dashboards panel duplicated what the All / Owned / Shared
          toggle already shows; only its accept/decline UI for pending
          invites was load-bearing, and that's now in
          `<PendingInvitesBanner>` which auto-hides when the queue is
          empty. */}
      <div className="h-[calc(100vh-72px)] flex flex-col p-6">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <PendingInvitesBanner onAccepted={handleSharedDashboardAccepted} />
          <DashboardList
            dashboards={dashboards}
            isLoading={status.isLoading}
            isRefreshing={status.refreshing}
            onViewDashboard={handleViewDashboard}
            onDeleteDashboard={handleDeleteClick}
            onCreateDashboard={async () => {
              // Generate a unique untitled name to avoid the server's
              // duplicate-name guard when the user clicks repeatedly.
              const stamp = new Date().toLocaleString();
              try {
                const created = await createDashboard(`Untitled · ${stamp}`);
                await handleViewDashboard(created);
              } catch (e) {
                console.error('Create dashboard failed:', e);
              }
            }}
          />
        </div>
      </div>

      <DeleteDashboardDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        dashboardName={dashboardToDeleteName}
        onConfirm={handleConfirmDelete}
        onCancel={handleDeleteCancel}
      />
    </>
  );
}