import { Request, Response } from "express";
import {
  getUserChats,
  getChatDocument,
  deleteChatDocument,
} from "../models/chat.model.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";

// Get all chats for a user
export const getUserChatHistory = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const pathUser = decodeURIComponent(req.params.username || "")
      .trim()
      .toLowerCase();
    if (!pathUser || pathUser !== authed) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const chats = await getUserChats(authed);

    const chatList = chats.map((chat) => ({
      id: chat.id,
      fileName: chat.fileName,
      uploadedAt: chat.uploadedAt,
      createdAt: chat.createdAt,
      lastUpdatedAt: chat.lastUpdatedAt,
      messageCount: chat.messages.length,
      chartCount: chat.charts.length,
    }));

    res.json({ chats: chatList });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Get user chats error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get user chats",
    });
  }
};

// Get specific chat details
export const getChatDetails = async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const username = requireUsername(req);

    const chat = await getChatDocument(chatId, username);

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    res.json({ chat });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Get chat details error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get chat details",
    });
  }
};

// Delete a chat
export const deleteChat = async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const username = requireUsername(req);

    await deleteChatDocument(chatId, username);

    res.json({ message: "Chat deleted successfully" });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Delete chat error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to delete chat",
    });
  }
};

// Get chat statistics for a user
export const getChatStatistics = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const pathUser = decodeURIComponent(req.params.username || "")
      .trim()
      .toLowerCase();
    if (!pathUser || pathUser !== authed) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const chats = await getUserChats(authed);

    const stats = {
      totalChats: chats.length,
      totalMessages: chats.reduce((sum, chat) => sum + chat.messages.length, 0),
      totalCharts: chats.reduce((sum, chat) => sum + chat.charts.length, 0),
      totalFiles: new Set(chats.map((chat) => chat.fileName)).size,
      lastActivity: chats.length > 0 ? Math.max(...chats.map((chat) => chat.lastUpdatedAt)) : null,
    };

    res.json({ statistics: stats });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("Get chat statistics error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to get chat statistics",
    });
  }
};
