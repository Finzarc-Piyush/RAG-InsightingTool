/**
 * Data Ops Stream Service
 * Handles streaming data operations with SSE
 */
import { Message } from "../../shared/schema.js";
import { parseDataOpsIntent, executeDataOperation } from "../../lib/dataOps/dataOpsOrchestrator.js";
import {
  getChatBySessionIdForUser,
  mutateChatDocument,
  addMessagesBySessionId,
  ChatDocument
} from "../../models/chat.model.js";
import { sendSSE, setSSEHeaders } from "../../utils/sse.helper.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { Response } from "express";
import { logger } from "../../lib/logger.js";
import { errorMessage } from "../../utils/errorMessage.js";

export interface ProcessStreamDataOpsParams {
  sessionId: string;
  message: string;
  dataOpsMode?: boolean;
  username: string;
  res: Response;
}

/**
 * Load data for operation using shared data loader
 * This ensures consistency with analysis - both use the same data source
 */
async function loadDataForOperation(
  chatDocument: ChatDocument,
  requiredColumns?: string[]
): Promise<Record<string, any>[]> {
  // Use the shared data loader to ensure we get the latest data
  // This ensures data operations work on the same data that analysis uses
  // For large datasets, we can filter columns to reduce memory usage
  return await loadLatestData(chatDocument, requiredColumns);
}

/**
 * Process a streaming data operations request
 */
export async function processStreamDataOperation(params: ProcessStreamDataOpsParams): Promise<void> {
  const { sessionId, message, dataOpsMode, username, res } = params;

  // Set SSE headers
  setSSEHeaders(res);

  // Track if client disconnected
  let clientDisconnected = false;

  // Handle client disconnect/abort
  const checkConnection = (): boolean => {
    if (res.writableEnded || res.destroyed || !res.writable) {
      clientDisconnected = true;
      return false;
    }
    return true;
  };

  // Set up connection close handlers
  res.on('close', () => {
    clientDisconnected = true;
    logger.log('🚫 Client disconnected from data ops stream');
  });

  res.on('error', (error: any) => {
    // ECONNRESET, EPIPE, ECONNABORTED are expected when client disconnects
    if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE' && error.code !== 'ECONNABORTED') {
      logger.error('SSE connection error:', error);
    }
    clientDisconnected = true;
  });

  try {
    // Get chat document - handle CosmosDB initialization errors gracefully
    let chatDocument: ChatDocument | null = null;
    try {
      chatDocument = await getChatBySessionIdForUser(sessionId, username);
    } catch (error: unknown) {
      // If CosmosDB isn't initialized, we can't get the document
      if (errorMessage(error).includes('CosmosDB container not initialized')) {
        logger.warn('⚠️ CosmosDB not initialized, cannot proceed without session document.');
        sendSSE(res, 'error', { error: 'Database is initializing. Please wait a moment and try again.' });
        res.end();
        return;
      }
      // Re-throw other errors
      throw error;
    }
    
    if (!chatDocument) {
      sendSSE(res, 'error', { error: 'Session not found. Please upload a file first.' });
      res.end();
      return;
    }

    // Update dataOpsMode if provided. Routes through mutateChatDocument (fresh
    // read + ETag precondition) so this whole-document write can't clobber a
    // concurrent message-append on a multi-instance deployment (invariant #9).
    if (dataOpsMode !== undefined && chatDocument.dataOpsMode !== dataOpsMode) {
      await mutateChatDocument(sessionId, (doc) => {
        if (doc.dataOpsMode === dataOpsMode) return false;
        doc.dataOpsMode = dataOpsMode;
      });
      chatDocument.dataOpsMode = dataOpsMode;
    }

    // Check connection before sending
    if (!checkConnection()) {
      return;
    }

    // Send thinking step
    if (!sendSSE(res, 'thinking', {
      step: 'Processing data operation',
      status: 'active',
      timestamp: Date.now(),
    })) {
      return; // Client disconnected
    }

    // Load data
    let fullData: Record<string, any>[];
    try {
      fullData = await loadDataForOperation(chatDocument);
    } catch (error: unknown) {
      logger.error('❌ Failed to load data:', error);
      const loadErrorMessage = errorMessage(error) || 'Failed to load data';
      sendSSE(res, 'error', {
        error: loadErrorMessage.includes('No data found')
          ? 'No data found. Please ensure your file was uploaded correctly and try uploading again.'
          : loadErrorMessage,
      });
      res.end();
      return;
    }
    
    if (!fullData || fullData.length === 0) {
      sendSSE(res, 'error', { error: 'No data found. Please ensure your file was uploaded correctly and try again.' });
      res.end();
      return;
    }
    
    logger.log(`✅ Using ${fullData.length} rows for data operation`);

    // Check connection before parsing
    if (!checkConnection()) {
      return;
    }

    // Parse intent
    if (!sendSSE(res, 'thinking', {
      step: 'Understanding your request',
      status: 'active',
      timestamp: Date.now(),
    })) {
      return; // Client disconnected
    }

    // Fetch last 15 messages from Cosmos DB for context
    const allMessages = chatDocument.messages || [];
    const chatHistory = allMessages.slice(-15);
    logger.log(`📚 Using ${chatHistory.length} messages from database for context`);

    const intent = await parseDataOpsIntent(message, chatHistory, chatDocument.dataSummary, chatDocument);

    // Check connection after parsing
    if (!checkConnection()) {
      return;
    }

    if (!sendSSE(res, 'thinking', {
      step: 'Understanding your request',
      status: 'completed',
      timestamp: Date.now(),
    })) {
      return; // Client disconnected
    }

    // Use last 15 messages for full chat history
    const fullChatHistory = chatHistory;

    // Check connection before executing
    if (!checkConnection()) {
      return;
    }

    // Execute operation
    if (!sendSSE(res, 'thinking', {
      step: 'Executing data operation',
      status: 'active',
      timestamp: Date.now(),
    })) {
      return; // Client disconnected
    }

    const result = await executeDataOperation(intent, fullData, sessionId, chatDocument, message, fullChatHistory);

    // Check connection after execution
    if (!checkConnection()) {
      return;
    }

    if (!sendSSE(res, 'thinking', {
      step: 'Executing data operation',
      status: 'completed',
      timestamp: Date.now(),
    })) {
      return; // Client disconnected
    }

    // Check connection before saving messages
    if (!checkConnection()) {
      logger.log('🚫 Client disconnected, skipping message save');
      return;
    }

    // Save messages only if client is still connected
    // Use consistent timestamp to prevent duplicates
    const assistantMessageTimestamp = Date.now();
    try {
      await addMessagesBySessionId(sessionId, [
        {
          role: 'user',
          content: message,
          timestamp: Date.now(),
          userEmail: username.toLowerCase(),
        },
        {
          role: 'assistant',
          content: result.answer,
          timestamp: assistantMessageTimestamp,
        },
      ]);
    } catch (error) {
      logger.error("⚠️ Failed to save messages:", error);
    }

    // Check connection before sending response
    if (!checkConnection()) {
      return;
    }

    // Send response
    if (!sendSSE(res, 'response', {
      answer: result.answer,
      preview: result.preview,
      summary: result.summary,
      saved: result.saved,
    })) {
      return; // Client disconnected
    }

    if (!sendSSE(res, 'done', {})) {
      return; // Client disconnected
    }

    if (!res.writableEnded && !res.destroyed) {
    res.end();
    }
    logger.log('✅ Data Ops stream completed successfully');
  } catch (error) {
    logger.error('Data Ops stream error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to process data operation';
    sendSSE(res, 'error', { error: errorMessage });
    res.end();
  }
}

