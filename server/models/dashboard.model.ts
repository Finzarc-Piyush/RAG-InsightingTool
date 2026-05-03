/**
 * Dashboard Model
 * Handles all database operations for dashboards
 */
import { randomUUID } from "crypto";
import {
  ChartSpec,
  Dashboard,
  DashboardTableSpec,
  DashboardPivotSpec,
  type CreateReportDashboardRequest,
  type DashboardNarrativeBlock,
  type DashboardSpec,
  type DashboardSheet,
  type DashboardPatch,
} from "../shared/schema.js";
import { waitForDashboardsContainer } from "./database.config.js";

/**
 * Create a new dashboard
 */
export const createDashboard = async (
  username: string,
  name: string,
  charts: ChartSpec[] = []
): Promise<Dashboard> => {
  const dashboardsContainer = await waitForDashboardsContainer();
  
  // Check if a dashboard with the same name already exists for this username
  const existingDashboards = await getUserDashboards(username);
  const duplicateDashboard = existingDashboards.find(
    d => d.name.toLowerCase().trim() === name.toLowerCase().trim()
  );
  
  if (duplicateDashboard) {
    throw new Error(`A dashboard with the name "${name}" already exists. Please enter a different name.`);
  }
  
  const timestamp = Date.now();
  const id = `${name.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}`;
  
  // Create default sheet with charts
  const defaultSheet = {
    id: 'default',
    name: 'Overview',
    charts,
    order: 0,
  };
  
  const dashboard: Dashboard = {
    id,
    username,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    charts, // Keep for backward compatibility
    sheets: [defaultSheet],
  };
  const { resource } = await dashboardsContainer.items.create(dashboard);
  return resource as unknown as Dashboard;
};

/**
 * Get all dashboards for a user
 */
export const getUserDashboards = async (username: string): Promise<Dashboard[]> => {
  try {
    const dashboardsContainer = await waitForDashboardsContainer();
    const { resources } = await dashboardsContainer.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.username = @username",
          parameters: [{ name: "@username", value: username }],
        },
        { partitionKey: username }
      )
      .fetchAll();
    const list = (resources ?? []) as unknown as Dashboard[];
    return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch (error) {
    console.error("Failed to get user dashboards:", error);
    return [];
  }
};

/**
 * Superadmin shadow-viewer · cross-partition list of every dashboard. Caller
 * MUST verify `isSuperadminEmail(email)` before invoking. Read-only — same
 * write-surface guarantees as `getChatBySessionIdForSuperadmin`.
 */
export const listAllDashboardsForSuperadmin = async (): Promise<Dashboard[]> => {
  try {
    const dashboardsContainer = await waitForDashboardsContainer();
    const { resources } = await dashboardsContainer.items
      .query(
        { query: "SELECT * FROM c" },
        { enableCrossPartitionQuery: true, maxItemCount: 1000 }
      )
      .fetchAll();
    const list = (resources ?? []) as unknown as Dashboard[];
    return list.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  } catch (error) {
    console.error("Failed to list all dashboards for superadmin:", error);
    return [];
  }
};

/**
 * Superadmin shadow-viewer · fetch any dashboard by id, bypassing the
 * collaborator check. Cross-partition because we don't know the owner. Caller
 * MUST verify `isSuperadminEmail(email)` before invoking.
 */
export const getDashboardByIdForSuperadmin = async (
  id: string
): Promise<Dashboard | null> => {
  try {
    const dashboardsContainer = await waitForDashboardsContainer();
    const { resources } = await dashboardsContainer.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.id = @id OFFSET 0 LIMIT 1",
          parameters: [{ name: "@id", value: id }],
        },
        { enableCrossPartitionQuery: true }
      )
      .fetchAll();
    return ((resources?.[0] ?? null) as unknown) as Dashboard | null;
  } catch (error) {
    console.error("Failed to fetch dashboard for superadmin:", error);
    return null;
  }
};

/**
 * Get dashboard by ID
 * Also checks if user has access via shared dashboard invite
 */
export const getDashboardById = async (id: string, username: string): Promise<Dashboard | null> => {
  try {
    const dashboardsContainer = await waitForDashboardsContainer();
    const normalizedUsername = username.toLowerCase();
    
    console.log(`[getDashboardById] Looking for dashboard ${id} for user ${normalizedUsername}`);
    
    // First try to get dashboard as owner (try both original and normalized)
    try {
      // Try with normalized username first (most common case)
      const { resource } = await dashboardsContainer.item(id, normalizedUsername).read();
      const dashboard = resource as unknown as Dashboard;
      
      console.log(`[getDashboardById] Resource from CosmosDB:`, { 
        exists: !!resource, 
        hasId: !!dashboard?.id, 
        hasName: !!dashboard?.name,
        username: dashboard?.username 
      });
      
      // Check if dashboard is valid (has required fields)
      if (dashboard && dashboard.id && dashboard.name) {
        console.log(`[getDashboardById] Found dashboard as owner: ${dashboard.name}`);
        // Update lastOpenedAt when dashboard is accessed
        dashboard.lastOpenedAt = Date.now();
        return await updateDashboard(dashboard);
      }
      
      // If dashboard is invalid, treat as not found
      console.log(`[getDashboardById] Dashboard resource is invalid or incomplete`);
      throw new Error('Dashboard resource is invalid');
    } catch (error: any) {
      // If normalized fails, try with original username (for backward compatibility)
      if (normalizedUsername !== username) {
        try {
          const { resource } = await dashboardsContainer.item(id, username).read();
          const dashboard = resource as unknown as Dashboard;
          
          if (dashboard && dashboard.id && dashboard.name) {
            console.log(`[getDashboardById] Found dashboard with original username: ${dashboard.name}`);
            dashboard.lastOpenedAt = Date.now();
            return await updateDashboard(dashboard);
          }
          
          // If dashboard is invalid, treat as not found
          throw new Error('Dashboard resource is invalid');
        } catch (secondError: any) {
          // Continue to shared dashboard check
          error = secondError;
        }
      }
      // If not found as owner, check if user has access via shared invite
      // CosmosDB errors can have code 404 or statusCode 404
      // Also check for invalid resource errors
      const isNotFound = error.code === 404 || error.statusCode === 404 || 
                        (error.message && (error.message.includes('NotFound') || error.message.includes('invalid'))) ||
                        (error.code === 'NotFound');
      
      console.log(`[getDashboardById] Dashboard not found as owner. Error code: ${error.code}, statusCode: ${error.statusCode}, isNotFound: ${isNotFound}`);
      
      if (isNotFound) {
        // First, try to get dashboard using any owner to check collaborators
        // We need to query all dashboards with this ID to find the owner
        const { resources: allDashboards } = await dashboardsContainer.items
          .query({
            query: "SELECT * FROM c WHERE c.id = @dashboardId",
            parameters: [{ name: "@dashboardId", value: id }],
          })
          .fetchAll();
        
        // Check if user is a collaborator in any of these dashboards
        for (const dashboardDoc of allDashboards) {
          const dashboard = dashboardDoc as unknown as Dashboard;
          if (dashboard && dashboard.collaborators) {
            const collaborator = dashboard.collaborators.find(
              (c) => c.userId.toLowerCase() === normalizedUsername
            );
            if (collaborator) {
              console.log(`[getDashboardById] Found user as collaborator with permission: ${collaborator.permission}`);
              // User is a collaborator, return the dashboard
              dashboard.lastOpenedAt = Date.now();
              return await updateDashboard(dashboard);
            }
          }
        }
        
        // If not found as collaborator, check shared invites (for backward compatibility)
        const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
        const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
        
        console.log(`[getDashboardById] Found ${sharedInvites.length} shared invites for user ${normalizedUsername}`);
        
        // Check if there's an accepted invite for this dashboard
        const acceptedInvite = sharedInvites.find(
          (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
        );
        
        if (acceptedInvite) {
          console.log(`[getDashboardById] Found accepted invite. Owner: ${acceptedInvite.ownerEmail}, Permission: ${acceptedInvite.permission}`);
          
          // Get the dashboard using the owner's username (normalized)
          const ownerUsername = acceptedInvite.ownerEmail.toLowerCase();
          try {
            const { resource } = await dashboardsContainer.item(id, ownerUsername).read();
            const dashboard = resource as unknown as Dashboard;
            
            // Check if dashboard is valid
            if (dashboard && dashboard.id && dashboard.name) {
              console.log(`[getDashboardById] Successfully retrieved shared dashboard: ${dashboard.name}`);
              // Update lastOpenedAt when dashboard is accessed
              dashboard.lastOpenedAt = Date.now();
              return await updateDashboard(dashboard);
            }
            
            // If dashboard is invalid, treat as not found
            console.error(`[getDashboardById] Shared dashboard resource is invalid for owner ${ownerUsername}`);
            throw new Error('Dashboard resource is invalid');
          } catch (ownerError: any) {
            const ownerIsNotFound = ownerError.code === 404 || ownerError.statusCode === 404 ||
                                   (ownerError.message && ownerError.message.includes('NotFound')) ||
                                   (ownerError.code === 'NotFound');
            if (ownerIsNotFound) {
              console.error(`[getDashboardById] Dashboard ${id} not found for owner ${ownerUsername}. Error:`, ownerError);
              return null;
            }
            throw ownerError;
          }
        } else {
          console.log(`[getDashboardById] No accepted invite found for dashboard ${id} and user ${normalizedUsername}`);
          console.log(`[getDashboardById] Available invites:`, sharedInvites.map(i => ({ id: i.sourceDashboardId, status: i.status })));
        }
      } else {
        // If it's not a 404 error, re-throw it
        console.error(`[getDashboardById] Unexpected error:`, error);
        throw error;
      }
      return null;
    }
  } catch (error: any) {
    const isNotFound = error.code === 404 || error.statusCode === 404 ||
                      (error.message && error.message.includes('NotFound')) ||
                      (error.code === 'NotFound');
    if (isNotFound) {
      console.log(`[getDashboardById] Final check - dashboard not found`);
      return null;
    }
    console.error(`[getDashboardById] Unexpected error in outer catch:`, error);
    throw error;
  }
};

/**
 * Rename a dashboard
 */
export const renameDashboard = async (
  id: string,
  username: string,
  newName: string
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();
  
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();
  
  if (dashboardOwner !== normalizedUsername) {
    // This is a shared dashboard, check if user has edit permission
    // First check collaborators
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      // Fallback to shared invites (for backward compatibility)
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  // Check if a dashboard with the same name already exists for this username (excluding current dashboard)
  // For shared dashboards, check against owner's dashboards
  const checkUsername = dashboardOwner || normalizedUsername;
  const existingDashboards = await getUserDashboards(checkUsername);
  const duplicateDashboard = existingDashboards.find(
    d => d.id !== id && d.name.toLowerCase().trim() === newName.toLowerCase().trim()
  );
  
  if (duplicateDashboard) {
    throw new Error(`A dashboard with the name "${newName}" already exists. Please enter a different name.`);
  }
  
  dashboard.name = newName;
  dashboard.updatedAt = Date.now();
  return updateDashboard(dashboard);
};

/**
 * Update dashboard
 */
export const updateDashboard = async (dashboard: Dashboard): Promise<Dashboard> => {
  const dashboardsContainer = await waitForDashboardsContainer();
  dashboard.updatedAt = Date.now();
  // Use the dashboard's username as the partition key
  const partitionKey = dashboard.username;
  const { resource } = await dashboardsContainer.item(dashboard.id, partitionKey).replace(dashboard);
  return resource as unknown as Dashboard;
};

/**
 * Delete dashboard
 */
export const deleteDashboard = async (id: string, username: string): Promise<void> => {
  const normalizedUsername = username.toLowerCase();
  
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();
  
  if (dashboardOwner !== normalizedUsername) {
    // This is a shared dashboard, check if user has edit permission
    // First check collaborators
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to delete this dashboard");
      }
    } else {
      // Fallback to shared invites (for backward compatibility)
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to delete this dashboard");
      }
    }
  }

  // Use the dashboard owner's username as partition key for deletion
  const dashboardsContainer = await waitForDashboardsContainer();
  await dashboardsContainer.item(id, dashboardOwner).delete();
};

/**
 * Add chart to dashboard
 */
export const addChartToDashboard = async (
  id: string,
  username: string,
  chart: ChartSpec,
  sheetId?: string
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();
  
  console.log(`[addChartToDashboard] Starting - Dashboard ID: ${id}, User: ${normalizedUsername}, SheetID: ${sheetId}`);
  
  // Try to get dashboard - it will handle both owned and shared dashboards
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) {
    console.error(`[addChartToDashboard] Dashboard ${id} not found for user ${normalizedUsername}`);
    throw new Error("Dashboard not found");
  }
  
  console.log(`[addChartToDashboard] Dashboard found: ${dashboard.name}, Owner: ${dashboard.username}`);
  
  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();
  
  if (dashboardOwner !== normalizedUsername) {
    // This is a shared dashboard, check if user has edit permission
    // First check collaborators
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    
    if (collaborator) {
      console.log(`[addChartToDashboard] User found as collaborator with permission: ${collaborator.permission}`);
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      // Fallback to shared invites (for backward compatibility)
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      
      console.log(`[addChartToDashboard] Shared dashboard check - Invite found: ${!!acceptedInvite}, Permission: ${acceptedInvite?.permission}`);
      
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }
  
  // Initialize sheets if not present (backward compatibility)
  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [{
      id: 'default',
      name: 'Overview',
      charts: [...dashboard.charts],
      order: 0,
    }];
  }
  
  // If sheetId is provided, add to that sheet; otherwise add to first sheet
  const targetSheetId = sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find(s => s.id === targetSheetId);
  
  if (!targetSheet) {
    throw new Error(`Sheet with id ${targetSheetId} not found`);
  }
  
  targetSheet.charts.push(chart);
  
  // Also update the legacy charts array for backward compatibility
  dashboard.charts.push(chart);
  
  // Use the dashboard's owner username for the partition key when updating
  return updateDashboard(dashboard);
};

/**
 * Add sheet to dashboard
 */
export const addSheetToDashboard = async (
  id: string,
  username: string,
  sheetName: string
): Promise<Dashboard> => {
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");
  
  // Initialize sheets if not present
  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [{
      id: 'default',
      name: 'Overview',
      charts: [...dashboard.charts],
      order: 0,
    }];
  }
  
  const trimmedName = sheetName.trim();
  
  // Check for duplicate sheet names (case-insensitive)
  const duplicateSheet = dashboard.sheets.find(s => 
    s.name.toLowerCase().trim() === trimmedName.toLowerCase()
  );
  
  if (duplicateSheet) {
    throw new Error(`A sheet with the name "${trimmedName}" already exists. Please enter a different name.`);
  }
  
  const newSheet = {
    id: `sheet-${Date.now()}`,
    name: trimmedName,
    charts: [],
    order: dashboard.sheets.length,
  };
  
  dashboard.sheets.push(newSheet);
  return updateDashboard(dashboard);
};

/**
 * Remove sheet from dashboard
 */
export const removeSheetFromDashboard = async (
  id: string,
  username: string,
  sheetId: string
): Promise<Dashboard> => {
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");
  
  if (!dashboard.sheets || dashboard.sheets.length <= 1) {
    throw new Error("Cannot remove the last sheet");
  }
  
  dashboard.sheets = dashboard.sheets.filter(s => s.id !== sheetId);
  return updateDashboard(dashboard);
};

/**
 * Rename sheet in dashboard
 */
export const renameSheet = async (
  id: string,
  username: string,
  sheetId: string,
  newName: string
): Promise<Dashboard> => {
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");
  
  if (!dashboard.sheets) {
    throw new Error("No sheets found");
  }
  
  const sheet = dashboard.sheets.find(s => s.id === sheetId);
  if (!sheet) throw new Error("Sheet not found");
  
  const trimmedName = newName.trim();
  
  // Check for duplicate sheet names (case-insensitive, excluding current sheet)
  const duplicateSheet = dashboard.sheets.find(s => 
    s.id !== sheetId && s.name.toLowerCase().trim() === trimmedName.toLowerCase()
  );
  
  if (duplicateSheet) {
    throw new Error(`A sheet with the name "${trimmedName}" already exists. Please enter a different name.`);
  }
  
  sheet.name = trimmedName;
  return updateDashboard(dashboard);
};

/**
 * Remove chart from dashboard
 */
export const removeChartFromDashboard = async (
  id: string,
  username: string,
  predicate: { index?: number; title?: string; type?: ChartSpec["type"]; sheetId?: string }
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();
  
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");
  
  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();
  
  if (dashboardOwner !== normalizedUsername) {
    // This is a shared dashboard, check if user has edit permission
    // First check collaborators
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      // Fallback to shared invites (for backward compatibility)
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  // If sheetId is provided, remove from that specific sheet
  if (predicate.sheetId && dashboard.sheets && dashboard.sheets.length > 0) {
    const sheet = dashboard.sheets.find(s => s.id === predicate.sheetId);
    if (!sheet) {
      // If sheet not found, check if it's a default sheet (backward compatibility)
      if (predicate.sheetId === 'default' && dashboard.charts.length > 0) {
        // For default sheet, remove from main charts array
        if (typeof predicate.index === 'number' && predicate.index >= 0 && predicate.index < dashboard.charts.length) {
          dashboard.charts.splice(predicate.index, 1);
        }
        return updateDashboard(dashboard);
      }
      throw new Error(`Sheet with id "${predicate.sheetId}" not found`);
    }

    if (typeof predicate.index === 'number') {
      if (predicate.index >= 0 && predicate.index < sheet.charts.length) {
        // Get the chart BEFORE removing it
        const chartToRemove = sheet.charts[predicate.index];
        
        // Remove from the specific sheet
        sheet.charts.splice(predicate.index, 1);
        
        // Check if this chart exists in other sheets
        const existsInOtherSheets = dashboard.sheets.some(s => 
          s.id !== sheet.id && s.charts.some(c => 
            c.title === chartToRemove.title && c.type === chartToRemove.type
          )
        );
        
        // Only remove from main charts array if it doesn't exist in other sheets
        if (!existsInOtherSheets) {
          const mainIndex = dashboard.charts.findIndex(c => 
            c.title === chartToRemove.title && c.type === chartToRemove.type
          );
          if (mainIndex >= 0) {
            dashboard.charts.splice(mainIndex, 1);
          }
        }
      }
    } else if (predicate.title || predicate.type) {
      // Filter sheet charts
      const removedCharts = sheet.charts.filter(c => {
        const titleMatch = predicate.title ? c.title === predicate.title : false;
        const typeMatch = predicate.type ? c.type === predicate.type : false;
        return titleMatch || typeMatch;
      });
      
      sheet.charts = sheet.charts.filter(c => {
        const titleMatch = predicate.title ? c.title !== predicate.title : true;
        const typeMatch = predicate.type ? c.type !== predicate.type : true;
        return titleMatch && typeMatch;
      });
      
      // Remove from main charts array only if not in other sheets
      removedCharts.forEach(removedChart => {
        const existsInOtherSheets = dashboard.sheets && dashboard.sheets.some(s => 
          s.id !== sheet.id && s.charts.some(c => 
            c.title === removedChart.title && c.type === removedChart.type
          )
        );
        
        if (!existsInOtherSheets) {
          const mainIndex = dashboard.charts.findIndex(c => 
            c.title === removedChart.title && c.type === removedChart.type
          );
          if (mainIndex >= 0) {
            dashboard.charts.splice(mainIndex, 1);
          }
        }
      });
    }
  } else {
    // Legacy behavior: remove from main charts array
    if (typeof predicate.index === 'number') {
      dashboard.charts.splice(predicate.index, 1);
      // Also remove from all sheets
      if (dashboard.sheets) {
        dashboard.sheets.forEach(sheet => {
          if (predicate.index! < sheet.charts.length) {
            sheet.charts.splice(predicate.index!, 1);
          }
        });
      }
    } else if (predicate.title || predicate.type) {
      dashboard.charts = dashboard.charts.filter(c => {
        const titleMatch = predicate.title ? c.title !== predicate.title : true;
        const typeMatch = predicate.type ? c.type !== predicate.type : true;
        return titleMatch && typeMatch;
      });
      // Also remove from all sheets
      if (dashboard.sheets) {
        dashboard.sheets.forEach(sheet => {
          sheet.charts = sheet.charts.filter(c => {
            const titleMatch = predicate.title ? c.title !== predicate.title : true;
            const typeMatch = predicate.type ? c.type !== predicate.type : true;
            return titleMatch && typeMatch;
          });
        });
      }
    }
  }

  return updateDashboard(dashboard);
};

/**
 * Update chart insight or recommendation
 */
export const updateChartInsightOrRecommendation = async (
  id: string,
  username: string,
  chartIndex: number,
  sheetId: string | undefined,
  updates: { keyInsight?: string }
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();
  
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");
  
  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();
  
  if (dashboardOwner !== normalizedUsername) {
    // This is a shared dashboard, check if user has edit permission
    // First check collaborators
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      // Fallback to shared invites (for backward compatibility)
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  // Initialize sheets if not present (backward compatibility)
  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [{
      id: 'default',
      name: 'Overview',
      charts: [...dashboard.charts],
      order: 0,
    }];
  }

  // Find the target sheet
  const targetSheetId = sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find(s => s.id === targetSheetId);

  if (!targetSheet) {
    throw new Error(`Sheet with id ${targetSheetId} not found`);
  }

  if (chartIndex < 0 || chartIndex >= targetSheet.charts.length) {
    throw new Error(`Chart index ${chartIndex} is out of range`);
  }

  const chart = targetSheet.charts[chartIndex];

  // Update the chart's keyInsight
  if (updates.keyInsight !== undefined) {
    // If empty string, set to undefined to remove it
    chart.keyInsight = updates.keyInsight === '' ? undefined : updates.keyInsight;
  }

  // Also update in the legacy charts array for backward compatibility
  // Find the matching chart in the main charts array
  const mainChartIndex = dashboard.charts.findIndex(c => 
    c.title === chart.title && c.type === chart.type
  );
  if (mainChartIndex >= 0) {
    if (updates.keyInsight !== undefined) {
      // If empty string, set to undefined to remove it
      dashboard.charts[mainChartIndex].keyInsight = updates.keyInsight === '' ? undefined : updates.keyInsight;
    }
  }

  return updateDashboard(dashboard);
};

/**
 * Add table to dashboard
 */
export const addTableToDashboard = async (
  id: string,
  username: string,
  table: DashboardTableSpec,
  sheetId?: string
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();

  // Try to get dashboard - it will handle both owned and shared dashboards
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  // Check if user has edit permission
  const dashboardOwner = dashboard.username?.toLowerCase();

  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );

    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );

      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  // Initialize sheets if not present (backward compatibility)
  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [
      {
        id: "default",
        name: "Overview",
        charts: [...dashboard.charts],
        tables: [],
        order: 0,
      },
    ];
  }

  const targetSheetId = sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find((s) => s.id === targetSheetId);

  if (!targetSheet) throw new Error(`Sheet with id ${targetSheetId} not found`);

  if (!targetSheet.tables) targetSheet.tables = [];
  targetSheet.tables.push(table);

  return updateDashboard(dashboard);
};

/**
 * Remove table from dashboard
 */
export const removeTableFromDashboard = async (
  id: string,
  username: string,
  predicate: { index: number; sheetId?: string }
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();

  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const dashboardOwner = dashboard.username?.toLowerCase();

  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );

    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );

      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    throw new Error("No sheets found");
  }

  const targetSheetId = predicate.sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find((s) => s.id === targetSheetId);
  if (!targetSheet) throw new Error(`Sheet with id "${targetSheetId}" not found`);

  if (!targetSheet.tables || targetSheet.tables.length === 0) {
    throw new Error("No tables found on the selected sheet");
  }

  if (predicate.index < 0 || predicate.index >= targetSheet.tables.length) {
    throw new Error(`Table index ${predicate.index} is out of range`);
  }

  targetSheet.tables.splice(predicate.index, 1);
  return updateDashboard(dashboard);
};

/**
 * Add pivot tile to dashboard. Idempotent on pivot id — re-adding the same
 * id replaces the prior entry (so a chat re-edit of an already-promoted pivot
 * doesn't create duplicates).
 */
export const addPivotToDashboard = async (
  id: string,
  username: string,
  pivot: DashboardPivotSpec,
  sheetId?: string
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();

  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const dashboardOwner = dashboard.username?.toLowerCase();
  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [
      {
        id: "default",
        name: "Overview",
        charts: [...dashboard.charts],
        order: 0,
      },
    ];
  }

  const targetSheetId = sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find((s) => s.id === targetSheetId);
  if (!targetSheet) throw new Error(`Sheet with id ${targetSheetId} not found`);

  if (!targetSheet.pivots) targetSheet.pivots = [];

  const existingIdx = targetSheet.pivots.findIndex((p) => p.id === pivot.id);
  if (existingIdx >= 0) {
    targetSheet.pivots[existingIdx] = pivot;
  } else {
    targetSheet.pivots.push(pivot);
  }

  return updateDashboard(dashboard);
};

/**
 * Remove pivot from dashboard sheet by index.
 */
export const removePivotFromDashboard = async (
  id: string,
  username: string,
  predicate: { index: number; sheetId?: string }
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();

  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const dashboardOwner = dashboard.username?.toLowerCase();
  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    throw new Error("No sheets found");
  }

  const targetSheetId = predicate.sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find((s) => s.id === targetSheetId);
  if (!targetSheet) throw new Error(`Sheet with id "${targetSheetId}" not found`);

  if (!targetSheet.pivots || targetSheet.pivots.length === 0) {
    throw new Error("No pivots found on the selected sheet");
  }

  if (predicate.index < 0 || predicate.index >= targetSheet.pivots.length) {
    throw new Error(`Pivot index ${predicate.index} is out of range`);
  }

  targetSheet.pivots.splice(predicate.index, 1);
  return updateDashboard(dashboard);
};

/**
 * Update table caption/title
 */
export const updateTableCaption = async (
  id: string,
  username: string,
  tableIndex: number,
  sheetId: string | undefined,
  updates: { caption?: string }
): Promise<Dashboard> => {
  const normalizedUsername = username.toLowerCase();

  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const dashboardOwner = dashboard.username?.toLowerCase();

  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );

    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );

      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  // Initialize sheets if not present (backward compatibility)
  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [
      {
        id: "default",
        name: "Overview",
        charts: [...dashboard.charts],
        tables: [],
        order: 0,
      },
    ];
  }

  const targetSheetId = sheetId || dashboard.sheets[0].id;
  const targetSheet = dashboard.sheets.find((s) => s.id === targetSheetId);
  if (!targetSheet) throw new Error(`Sheet with id ${targetSheetId} not found`);

  if (!targetSheet.tables || targetSheet.tables.length === 0) {
    throw new Error("No tables found on the selected sheet");
  }

  if (tableIndex < 0 || tableIndex >= targetSheet.tables.length) {
    throw new Error(`Table index ${tableIndex} is out of range`);
  }

  const table = targetSheet.tables[tableIndex];

  if (updates.caption !== undefined) {
    table.caption = updates.caption;
  }

  return updateDashboard(dashboard);
};

/**
 * Create a two-sheet report dashboard (Summary narratives + Evidence charts/tables).
 * Retries on duplicate dashboard name.
 */
export const createReportDashboardFromAnalysis = async (
  username: string,
  body: CreateReportDashboardRequest
): Promise<Dashboard> => {
  const baseName = body.name.trim().slice(0, 200);
  let name = baseName;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const dashboard = await createDashboard(username, name, []);
      const narrativeBlocks: DashboardNarrativeBlock[] = [
        {
          id: randomUUID(),
          role: "summary",
          title: "Executive summary",
          body: body.summaryBody,
          order: 0,
        },
      ];
      if (body.limitationsBody?.trim()) {
        narrativeBlocks.push({
          id: randomUUID(),
          role: "limitations",
          title: "Limitations",
          body: body.limitationsBody.trim(),
          order: 1,
        });
      }
      if (body.recommendationsBody?.trim()) {
        narrativeBlocks.push({
          id: randomUUID(),
          role: "recommendations",
          title: "Recommendations",
          body: body.recommendationsBody.trim(),
          order: 2,
        });
      }
      const charts = body.charts ?? [];
      dashboard.sheets = [
        {
          id: "sheet_summary",
          name: "Summary",
          charts: [],
          narrativeBlocks,
          order: 0,
        },
        {
          id: "sheet_evidence",
          name: "Evidence",
          charts: [...charts],
          ...(body.table ? { tables: [body.table] } : {}),
          order: 1,
        },
      ];
      dashboard.charts = [...charts];
      return updateDashboard(dashboard);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already exists") && attempt < 7) {
        name = `${baseName} (${attempt + 2})`;
        continue;
      }
      throw e;
    }
  }
  throw new Error("Could not allocate a unique dashboard name.");
};

/**
 * Phase 2 — atomic persistence of an agent-emitted DashboardSpec.
 *
 * The spec already carries the full sheet layout (charts, narrative blocks,
 * tables, optional gridLayout). This helper just reshapes it onto the
 * Cosmos Dashboard document type, honours unique-name allocation (same
 * retry pattern as createReportDashboardFromAnalysis), and writes once.
 */
export const createDashboardFromSpec = async (
  username: string,
  spec: DashboardSpec,
  // W59 · Optional session this dashboard came from — used to record a
  // `dashboard_promoted` entry in the per-session Memory journal.
  sessionId?: string
): Promise<Dashboard> => {
  const baseName = spec.name.trim().slice(0, 200) || "Analysis dashboard";
  let name = baseName;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const dashboard = await createDashboard(username, name, []);
      // Materialise sheets in the user-specified order; each sheet carries
      // whatever structured content the agent chose (charts / narrative /
      // tables / gridLayout). Stable sheet ids survive round-trips.
      const sheets: DashboardSheet[] = spec.sheets.map((s, idx) => ({
        id: s.id || `sheet_${idx}`,
        name: s.name,
        charts: s.charts ? [...s.charts] : [],
        ...(s.pivots && s.pivots.length > 0 ? { pivots: [...s.pivots] } : {}),
        ...(s.tables && s.tables.length > 0 ? { tables: [...s.tables] } : {}),
        ...(s.narrativeBlocks && s.narrativeBlocks.length > 0
          ? { narrativeBlocks: [...s.narrativeBlocks] }
          : {}),
        ...(s.gridLayout ? { gridLayout: s.gridLayout } : {}),
        order: typeof s.order === "number" ? s.order : idx,
      }));

      // Top-level `charts` stays populated with the union of sheet charts
      // so the existing list view / export paths continue to work.
      const unionCharts: ChartSpec[] = [];
      for (const s of sheets) {
        if (Array.isArray(s.charts)) unionCharts.push(...s.charts);
      }

      dashboard.sheets = sheets;
      dashboard.charts = unionCharts;
      if (spec.answerEnvelope) {
        dashboard.answerEnvelope = spec.answerEnvelope;
      }
      // Wave-FA6 · Snapshot active filter into the dashboard for provenance.
      if (spec.capturedActiveFilter) {
        dashboard.capturedActiveFilter = spec.capturedActiveFilter;
      }
      const persisted = await updateDashboard(dashboard);
      // W59 · record `dashboard_promoted` in the per-session Memory journal so
      // resume-after-days shows the dashboard as a milestone in the timeline.
      if (sessionId) {
        void (async () => {
          try {
            const { buildDashboardPromotedEntry, scheduleLifecycleMemory } =
              await import(
                "../lib/agents/runtime/memoryLifecycleBuilders.js"
              );
            scheduleLifecycleMemory(
              buildDashboardPromotedEntry({
                sessionId,
                username,
                dashboardId: persisted.id,
                dashboardName: persisted.name,
                sheetCount: sheets.length,
                chartCount: unionCharts.length,
                createdAt: Date.now(),
              })
            );
          } catch (e) {
            console.warn(
              "⚠️ analysisMemory dashboard_promoted hook failed:",
              e
            );
          }
        })();
      }
      return persisted;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("already exists") && attempt < 7) {
        name = `${baseName} (${attempt + 2})`;
        continue;
      }
      throw e;
    }
  }
  throw new Error("Could not allocate a unique dashboard name.");
};

/**
 * Phase 2.E — apply a DashboardPatch to an existing dashboard atomically.
 *
 * Order of operations matters:
 *   1. removeCharts   — index-based per sheet; higher indices drop first
 *                        so lower indices stay valid while we splice.
 *   2. addCharts      — append to the named sheet (or first chart sheet).
 *   3. renameSheet    — rename + no-op when the id doesn't match.
 *
 * The top-level `dashboard.charts` array is kept in sync with the union
 * of sheet charts so existing list views + exports keep working.
 */
export const patchDashboard = async (
  id: string,
  username: string,
  patch: DashboardPatch
): Promise<Dashboard> => {
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const normalizedUsername = username.toLowerCase();
  const dashboardOwner = dashboard.username?.toLowerCase();
  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    if (!collaborator || collaborator.permission !== "edit") {
      throw new Error("You do not have permission to edit this dashboard");
    }
  }

  const sheets = Array.isArray(dashboard.sheets) ? [...dashboard.sheets] : [];

  // 1. Removals — process highest-index first, per sheet, so lower indices
  // stay valid as we splice. Unknown sheet ids / out-of-range indices are
  // ignored rather than throwing; patches should be idempotent-ish.
  if (patch.removeCharts && patch.removeCharts.length > 0) {
    const bySheet = new Map<string, number[]>();
    for (const r of patch.removeCharts) {
      const arr = bySheet.get(r.sheetId) ?? [];
      arr.push(r.chartIndex);
      bySheet.set(r.sheetId, arr);
    }
    for (const [sheetId, indices] of bySheet) {
      const sheet = sheets.find((s) => s.id === sheetId);
      if (!sheet || !Array.isArray(sheet.charts)) continue;
      const ordered = Array.from(new Set(indices)).sort((a, b) => b - a);
      for (const idx of ordered) {
        if (idx >= 0 && idx < sheet.charts.length) {
          sheet.charts.splice(idx, 1);
        }
      }
    }
  }

  // 2. Additions — default target is the first sheet that already has a
  // `charts` array (the canonical "evidence" sheet in Phase-2 specs);
  // fall back to sheet 0.
  if (patch.addCharts && patch.addCharts.length > 0) {
    const defaultSheet =
      sheets.find((s) => Array.isArray(s.charts)) ?? sheets[0];
    if (!defaultSheet) {
      throw new Error("Dashboard has no sheets to add charts to");
    }
    for (const entry of patch.addCharts) {
      const target = entry.sheetId
        ? sheets.find((s) => s.id === entry.sheetId) ?? defaultSheet
        : defaultSheet;
      if (!Array.isArray(target.charts)) target.charts = [];
      target.charts.push(entry.chart);
    }
  }

  // 3. Rename — simple label change; idempotent when no match.
  if (patch.renameSheet) {
    const sheet = sheets.find((s) => s.id === patch.renameSheet!.sheetId);
    if (sheet) {
      sheet.name = patch.renameSheet.name.trim().slice(0, 200);
    }
  }

  dashboard.sheets = sheets;
  dashboard.charts = sheets.flatMap((s) =>
    Array.isArray(s.charts) ? s.charts : []
  );
  return updateDashboard(dashboard);
};

export const patchDashboardSheet = async (
  id: string,
  username: string,
  sheetId: string,
  patch: {
    narrativeBlocks?: DashboardNarrativeBlock[];
    gridLayout?: Record<
      string,
      { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }[]
    >;
  }
): Promise<Dashboard> => {
  const dashboard = await getDashboardById(id, username);
  if (!dashboard) throw new Error("Dashboard not found");

  const normalizedUsername = username.toLowerCase();
  const dashboardOwner = dashboard.username?.toLowerCase();
  if (dashboardOwner !== normalizedUsername) {
    const collaborator = dashboard.collaborators?.find(
      (c) => c.userId.toLowerCase() === normalizedUsername
    );
    if (collaborator) {
      if (collaborator.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    } else {
      const { listSharedDashboardsForUser } = await import("./sharedDashboard.model.js");
      const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
      const acceptedInvite = sharedInvites.find(
        (invite) => invite.sourceDashboardId === id && invite.status === "accepted"
      );
      if (!acceptedInvite || acceptedInvite.permission !== "edit") {
        throw new Error("You do not have permission to edit this dashboard");
      }
    }
  }

  if (!dashboard.sheets || dashboard.sheets.length === 0) {
    dashboard.sheets = [
      {
        id: "default",
        name: "Overview",
        charts: [...dashboard.charts],
        order: 0,
      },
    ];
  }
  const sheet = dashboard.sheets.find((s) => s.id === sheetId);
  if (!sheet) throw new Error(`Sheet with id ${sheetId} not found`);

  if (patch.narrativeBlocks !== undefined) {
    sheet.narrativeBlocks = patch.narrativeBlocks;
  }
  if (patch.gridLayout !== undefined) {
    sheet.gridLayout = patch.gridLayout;
  }

  return updateDashboard(dashboard);
};

