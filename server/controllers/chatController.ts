/**
 * Chat Controller
 * Thin controller layer for chat endpoints - delegates to services
 */
import { Request, Response } from "express";
import type { Request as ExpressRequest } from "express";
import { processChatMessage } from "../services/chat/chat.service.js";
import { createErrorResponse } from "../services/chat/chatResponse.service.js";
import { processStreamChat, streamChatMessages } from "../services/chat/chatStream.service.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { sendError, sendValidationError, sendNotFound } from "../utils/responseFormatter.js";

/**
 * Non-streaming chat endpoint
 */
export const chatWithAI = async (req: Request, res: Response) => {
  try {
    const { sessionId, message, targetTimestamp } = req.body;
    const username = requireUsername(req);

    // Validate required fields
    if (!sessionId || !message) {
      return sendValidationError(res, 'Missing required fields');
    }

    // Process chat message (chatHistory will be fetched from Cosmos DB in the service)
    const result = await processChatMessage({
      sessionId,
      message,
      targetTimestamp,
      username,
    });

    if ("queuedUntilEnrichment" in result && result.queuedUntilEnrichment) {
      return res.status(202).json({
        queuedUntilEnrichment: true,
        message:
          "Your message is queued until we finish understanding your data. You will see the reply shortly.",
      });
    }

    res.json(result);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Chat error:', error);
    const errorResponse = createErrorResponse(error as Error);
    res.status(500).json(errorResponse);
  }
};

/**
 * Streaming chat endpoint using Server-Sent Events (SSE)
 */
export const chatWithAIStream = async (req: Request, res: Response) => {
  try {
    const { sessionId, message, targetTimestamp, mode } = req.body;
    const username = requireUsername(req);

    // Validate required fields
    if (!sessionId || !message) {
      return;
    }

    // Validate mode if provided (treat 'general' as undefined for auto-detection)
    const validMode = mode && ['general', 'analysis', 'dataOps', 'modeling'].includes(mode) 
      ? (mode === 'general' ? undefined : mode)
      : undefined;

    // Process streaming chat (chatHistory will be fetched from Cosmos DB in the service)
    await processStreamChat({
      sessionId,
      message,
      targetTimestamp,
      username,
      res,
      mode: validMode,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      if (!res.headersSent) {
        res.status(401).json({ error: (error as AuthenticationError).message });
      }
      return;
    }
    console.error('Chat stream error:', error);
    // Error handling is done in the service
  }
};

/**
 * Streaming chat messages endpoint using Server-Sent Events (SSE)
 * Provides real-time updates for chat messages in a session
 */
export const streamChatMessagesController = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return;
    }

    let username: string;
    try {
      username = requireUsername(req);
    } catch (e) {
      if (e instanceof AuthenticationError && !res.headersSent) {
        res.status(401).json({ error: e.message });
      }
      return;
    }

    await streamChatMessages(sessionId, username, req as ExpressRequest, res);
  } catch (error) {
    console.error("streamChatMessagesController error:", error);
    // Error handling is done in the service
  }
};
