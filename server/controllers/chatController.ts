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
import { sendSSE, setSSEHeaders } from "../utils/sse.helper.js";

/**
 * Wall-clock budget for a single streaming chat turn. Even with internal
 * agent-loop deadlines, a hung downstream await can leave the SSE response
 * open indefinitely; this is the outer backstop (P-008).
 */
const STREAM_CHAT_HARD_TIMEOUT_MS = Number(
  process.env.STREAM_CHAT_HARD_TIMEOUT_MS || 150_000
);

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
    const { sessionId, message, targetTimestamp, mode } = req.body ?? {};
    const username = requireUsername(req);

    // P-018: return a structured HTTP 400 instead of silently ending the
    // handler when the payload is malformed. Callers previously hung because
    // the connection stayed open with no error frame and no status code.
    if (!sessionId || typeof sessionId !== 'string' || !message || typeof message !== 'string') {
      return sendValidationError(
        res,
        'Missing or invalid required fields: sessionId, message'
      );
    }

    // `mode` is accepted for backward compatibility but ignored for routing (classifyMode always runs).
    const _legacyMode =
      mode && ['general', 'analysis', 'dataOps', 'modeling'].includes(mode) ? mode : undefined;

    // P-008: race the whole stream against a wall-clock budget so a hung
    // downstream await cannot keep the SSE response open forever.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error('STREAM_CHAT_TIMEOUT'));
      }, STREAM_CHAT_HARD_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        processStreamChat({
          sessionId,
          message,
          targetTimestamp,
          username,
          res,
          mode: _legacyMode,
        }),
        timeoutPromise,
      ]);
    } catch (streamErr) {
      const timedOut =
        streamErr instanceof Error && streamErr.message === 'STREAM_CHAT_TIMEOUT';
      if (timedOut) {
        console.warn(
          `⏱️ chatWithAIStream exceeded ${STREAM_CHAT_HARD_TIMEOUT_MS}ms for session ${sessionId}; closing`
        );
        try {
          if (!res.headersSent) {
            setSSEHeaders(res);
          }
          if (!res.writableEnded) {
            sendSSE(res, 'error', {
              message:
                'The request took too long and was cancelled. Please try again or narrow the scope.',
              code: 'STREAM_CHAT_TIMEOUT',
            });
            res.end();
          }
        } catch {
          // swallow — connection already torn down
        }
      } else {
        throw streamErr;
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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
