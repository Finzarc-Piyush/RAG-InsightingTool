import { Router } from "express";
import { chatWithAI, chatWithAIStream, streamChatMessagesController } from "../controllers/chatController.js";
import { budgetGate } from "../middleware/budgetGate.js";

const router = Router();

// Chat endpoint
router.post('/chat', budgetGate, chatWithAI);

// Streaming chat endpoint (SSE) — gated on daily per-user quota.
router.post('/chat/stream', budgetGate, chatWithAIStream);

// Real-time chat messages streaming endpoint (SSE)
router.get('/chat/:sessionId/stream', streamChatMessagesController);

export default router;
