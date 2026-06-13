import { Router } from "express";
import { 
  getUserChatHistory, 
  getChatDetails, 
  deleteChat, 
  getChatStatistics 
} from "../controllers/chatManagementController.js";

const router = Router();

// Get all chats for a user
router.get('/chats/user/:username', getUserChatHistory);

// Get chat statistics for a user
router.get('/chats/user/:username/statistics', getChatStatistics);

// Get specific chat details
router.get('/chats/:chatId', getChatDetails);

// Delete a chat
router.delete('/chats/:chatId', deleteChat);

export default router;

