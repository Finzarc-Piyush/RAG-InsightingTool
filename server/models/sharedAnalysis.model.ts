/**
 * Shared Analysis Model
 * Handles all database operations for shared analysis invites
 */
import { SharedAnalysisInvite } from "../shared/schema.js";
import { waitForSharedAnalysesContainer } from "./database.config.js";
import { getChatBySessionIdEfficient, mutateChatDocument, type ChatDocument } from "./chat.model.js";
import { logger } from "../lib/logger.js";
import { sharedAnalysisInviteReadSchema, safeParseRead } from "./persistedSchemas.js";
import { errorMessage, getErrorCode } from "../utils/errorMessage.js";

const normalizeEmail = (value: string) => value?.trim().toLowerCase();

/**
 * Helper function to retry Cosmos DB operations on connection errors
 */
const retryOnConnectionError = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  operationName: string = "Cosmos DB operation"
): Promise<T> => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const message = errorMessage(error);
      const code = getErrorCode(error);

      // Check if it's a connection error that might be retryable
      const isRetryableError =
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "ENOTFOUND" ||
        code === "ECONNRESET" ||
        message.includes("ECONNREFUSED") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ENOTFOUND");

      if (isRetryableError && attempt < maxRetries) {
        const delay = attempt * 1000; // Exponential backoff: 1s, 2s, 3s
        logger.warn(`⚠️ ${operationName} connection error (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms...`, message);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // If not retryable or max retries reached, throw
      throw error;
    }
  }
  
  throw lastError;
};

const ensureCollaborators = (chatDocument: ChatDocument): string[] => {
  const owner = normalizeEmail(chatDocument.username);
  const collaborators = Array.from(
    new Set(
      (chatDocument.collaborators || [])
        .map(normalizeEmail)
        .filter((email): email is string => Boolean(email))
    )
  );

  if (!collaborators.includes(owner)) {
    collaborators.unshift(owner);
  }

  chatDocument.collaborators = collaborators;
  return collaborators;
};

/**
 * Build preview object for shared analysis
 */
const buildSharedAnalysisPreview = (chatDocument: ChatDocument) => ({
  fileName: chatDocument.fileName,
  uploadedAt: chatDocument.uploadedAt,
  createdAt: chatDocument.createdAt,
  lastUpdatedAt: chatDocument.lastUpdatedAt,
  chartsCount: chatDocument.charts?.length || 0,
  insightsCount: chatDocument.insights?.length || 0,
  messagesCount: chatDocument.messages?.length || 0,
});

/**
 * Create a shared analysis invite
 */
export const createSharedAnalysisInvite = async ({
  ownerEmail,
  targetEmail,
  sourceSessionId,
  note,
  dashboardId,
  dashboardEditable,
  dashboardIds,
  dashboardPermissions,
}: {
  ownerEmail: string;
  targetEmail: string;
  sourceSessionId: string;
  note?: string;
  dashboardId?: string;
  dashboardEditable?: boolean;
  dashboardIds?: string[];
  dashboardPermissions?: Record<string, 'view' | 'edit'>;
}): Promise<SharedAnalysisInvite> => {
  if (!ownerEmail || !targetEmail) {
    const error = new Error("Both owner and target emails are required to share an analysis.");
    (error as any).statusCode = 400;
    throw error;
  }

  const normalizedOwner = normalizeEmail(ownerEmail) || ownerEmail;
  const normalizedTarget = normalizeEmail(targetEmail) || targetEmail;

  if (normalizedOwner === normalizedTarget) {
    const error = new Error("You cannot share an analysis with yourself.");
    (error as any).statusCode = 400;
    throw error;
  }

  const sharedContainer = await waitForSharedAnalysesContainer();
  const sourceChat = await getChatBySessionIdEfficient(sourceSessionId);

  if (!sourceChat) {
    throw new Error("Unable to find the source analysis to share.");
  }

  if (normalizeEmail(sourceChat.username) !== normalizedOwner) {
    const error = new Error("You can only share analyses that you own.");
    (error as any).statusCode = 403;
    throw error;
  }

  const collaborators = ensureCollaborators(sourceChat);
  if (collaborators.includes(normalizedTarget)) {
    const error = new Error("This teammate already has access to the shared analysis.");
    (error as any).statusCode = 409;
    throw error;
  }

  const timestamp = Date.now();
  
  // Use dashboardIds if provided, otherwise fall back to single dashboardId
  const dashboardsToShare = dashboardIds && dashboardIds.length > 0 
    ? dashboardIds 
    : dashboardId 
      ? [dashboardId] 
      : [];

  const invite: SharedAnalysisInvite = {
    id: `shared_${sourceChat.id}_${timestamp}`,
    sourceSessionId,
    sourceChatId: sourceChat.id,
    ownerEmail: normalizedOwner,
    targetEmail: normalizedTarget,
    status: "pending",
    createdAt: timestamp,
    note,
    preview: buildSharedAnalysisPreview(sourceChat),
    dashboardId: dashboardsToShare[0], // Store first one for backward compatibility
    dashboardEditable: dashboardPermissions 
      ? dashboardPermissions[dashboardsToShare[0]!] === 'edit'
      : dashboardEditable,
  };

  const { resource } = await sharedContainer.items.create(invite);

  // Create dashboard share invites for all selected dashboards
  if (dashboardsToShare.length > 0) {
    try {
      const { createSharedDashboardInvite } = await import("./sharedDashboard.model.js");
      
      // Share all dashboards
      await Promise.all(
        dashboardsToShare.map(async (dashboardId) => {
          const permission = dashboardPermissions 
            ? dashboardPermissions[dashboardId] || 'view'
            : dashboardEditable 
              ? 'edit' 
              : 'view';
          
          try {
            await createSharedDashboardInvite({
              ownerEmail: normalizedOwner,
              targetEmail: normalizedTarget,
              sourceDashboardId: dashboardId,
              permission,
              note: note ? `Shared along with analysis: ${note}` : "Shared along with analysis",
            });
          } catch (dashboardError: unknown) {
            // Log error but continue with other dashboards
            logger.error(`Failed to create dashboard share invite for ${dashboardId}:`, dashboardError);
          }
        })
      );
    } catch (error: unknown) {
      // Log error but don't fail the analysis share if dashboard share fails
      logger.error("Failed to create dashboard share invites:", error);
      // Continue with analysis share even if dashboard share fails
    }
  }

  return resource as unknown as SharedAnalysisInvite;
};

/**
 * List shared analyses for a user (incoming invites)
 */
export const listSharedAnalysesForUser = async (targetEmail: string): Promise<SharedAnalysisInvite[]> => {
  try {
    const sharedContainer = await waitForSharedAnalysesContainer();
    const normalizedTarget = normalizeEmail(targetEmail) || targetEmail;
    
    return retryOnConnectionError(async () => {
      // Use partition key directly - no need for cross-partition query
      // Since partition key is /targetEmail, query within partition
      const { resources } = await sharedContainer.items.query({
        query: "SELECT * FROM c WHERE c.targetEmail = @targetEmail ORDER BY c.createdAt DESC",
        parameters: [{ name: "@targetEmail", value: normalizedTarget }],
      }).fetchAll(); // Remove enableCrossPartitionQuery for better performance

      return resources.map((r) =>
        safeParseRead<SharedAnalysisInvite>(
          "listSharedAnalysesForUser",
          sharedAnalysisInviteReadSchema,
          r,
        ),
      );
    }, 3, "listSharedAnalysesForUser");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // If it's a connection error, return empty array instead of throwing
    // This allows the app to continue functioning even when CosmosDB is unavailable
    if (
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("ETIMEDOUT") ||
      errorMessage.includes("ENOTFOUND") ||
      errorMessage.includes("not initialized") ||
      (error as any)?.code === "ECONNREFUSED" ||
      (error as any)?.code === "ETIMEDOUT" ||
      (error as any)?.code === "ENOTFOUND"
    ) {
      logger.warn(`⚠️ CosmosDB unavailable for listSharedAnalysesForUser, returning empty array. Error: ${errorMessage}`);
      return [];
    }
    // Re-throw other errors
    throw error;
  }
};

/**
 * List shared analyses for owner (sent invites)
 */
export const listSharedAnalysesForOwner = async (ownerEmail: string): Promise<SharedAnalysisInvite[]> => {
  const sharedContainer = await waitForSharedAnalysesContainer();
  const normalizedOwner = normalizeEmail(ownerEmail) || ownerEmail;
  
  return retryOnConnectionError(async () => {
    const { resources } = await sharedContainer.items
      .query(
        {
          query: "SELECT * FROM c WHERE c.ownerEmail = @ownerEmail ORDER BY c.createdAt DESC",
          parameters: [{ name: "@ownerEmail", value: normalizedOwner }],
        }
      )
      .fetchAll();

    return resources.map((r) =>
      safeParseRead<SharedAnalysisInvite>(
        "listSharedAnalysesForOwner",
        sharedAnalysisInviteReadSchema,
        r,
      ),
    );
  }, 3, "listSharedAnalysesForOwner");
};

/**
 * Get shared analysis invite by ID
 */
export const getSharedAnalysisInviteById = async (
  id: string,
  targetEmail: string
): Promise<SharedAnalysisInvite | null> => {
  const sharedContainer = await waitForSharedAnalysesContainer();
  const normalizedTarget = normalizeEmail(targetEmail) || targetEmail;
  
  try {
    return await retryOnConnectionError(async () => {
      const { resource } = await sharedContainer.item(id, normalizedTarget).read();
      return safeParseRead<SharedAnalysisInvite>(
        "getSharedAnalysisInviteById",
        sharedAnalysisInviteReadSchema,
        resource,
      );
    }, 3, "getSharedAnalysisInviteById");
  } catch (error: unknown) {
    // Cosmos 404 surfaces as a numeric `code`; getErrorCode stringifies it.
    if (getErrorCode(error) === "404") {
      return null;
    }
    throw error;
  }
};

/**
 * Accept a shared analysis invite
 */
export const acceptSharedAnalysisInvite = async (
  id: string,
  targetEmail: string
): Promise<{ invite: SharedAnalysisInvite; newSession: ChatDocument }> => {
  const sharedContainer = await waitForSharedAnalysesContainer();
  const normalizedTarget = normalizeEmail(targetEmail) || targetEmail;
  const invite = await getSharedAnalysisInviteById(id, normalizedTarget);

  if (!invite) {
    const error = new Error("Shared analysis invite not found.");
    (error as any).statusCode = 404;
    throw error;
  }

  if (invite.status === "declined") {
    const error = new Error("This shared analysis invite has already been declined.");
    (error as any).statusCode = 400;
    throw error;
  }

  const sourceChat = await getChatBySessionIdEfficient(invite.sourceSessionId);
  if (!sourceChat) {
    const error = new Error("The original analysis is no longer available.");
    (error as any).statusCode = 404;
    throw error;
  }

  // SEC-2: add the collaborator through the `mutateChatDocument` seam (invariant
  // #9) so the read-modify-write takes the per-session lock + IfMatch `_etag`
  // retry. Previously this was a bare get→mutate→update: two invites accepted
  // concurrently could each read the same collaborator list and clobber the
  // other's append (lost update). The mutator re-reads the FRESH doc inside the
  // lock, so the list only ever grows.
  const updatedChat = await mutateChatDocument(invite.sourceSessionId, (doc) => {
    const collaborators = ensureCollaborators(doc);
    if (collaborators.includes(normalizedTarget)) return false; // already present — no write
    doc.collaborators = [...collaborators, normalizedTarget];
    return true;
  });
  const newSession = updatedChat ?? sourceChat;

  const updatedInvite: SharedAnalysisInvite = {
    ...invite,
    status: "accepted",
    acceptedAt: Date.now(),
    acceptedSessionId: newSession.sessionId,
  };

  const { resource } = await sharedContainer.items.upsert(updatedInvite);

  return {
    invite: resource as unknown as SharedAnalysisInvite,
    newSession,
  };
};

/**
 * Decline a shared analysis invite
 */
export const declineSharedAnalysisInvite = async (
  id: string,
  targetEmail: string
): Promise<SharedAnalysisInvite> => {
  const sharedContainer = await waitForSharedAnalysesContainer();
  const normalizedTarget = normalizeEmail(targetEmail) || targetEmail;
  const invite = await getSharedAnalysisInviteById(id, normalizedTarget);

  if (!invite) {
    const error = new Error("Shared analysis invite not found.");
    (error as any).statusCode = 404;
    throw error;
  }

  if (invite.status !== "pending") {
    return invite;
  }

  const updatedInvite: SharedAnalysisInvite = {
    ...invite,
    status: "declined",
    declinedAt: Date.now(),
  };

  const { resource } = await sharedContainer.items.upsert(updatedInvite);
  return resource as unknown as SharedAnalysisInvite;
};

