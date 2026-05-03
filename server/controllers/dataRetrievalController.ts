import { Request, Response } from "express";
import {
  getUserChats,
  getChatDocument,
  getChatBySessionIdForUser,
} from "../models/chat.model.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { applyActiveFilter } from "../lib/activeFilter/applyActiveFilter.js";

// Get all analysis sessions for a user
export const getUserAnalysisSessions = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const pathUser = decodeURIComponent(req.params.username || "")
      .trim()
      .toLowerCase();
    if (!pathUser || pathUser !== authed) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const chats = await getUserChats(authed);
    
    // Return summary information for each chat (without full raw data)
    const sessions = chats.map(chat => ({
      id: chat.id,
      fileName: chat.fileName,
      uploadedAt: chat.uploadedAt,
      createdAt: chat.createdAt,
      lastUpdatedAt: chat.lastUpdatedAt,
      collaborators: chat.collaborators || [chat.username],
      dataSummary: chat.dataSummary,
      chartsCount: chat.charts.length,
      insightsCount: chat.insights?.length || 0,
      messagesCount: chat.messages.length,
      blobInfo: chat.blobInfo,
      analysisMetadata: chat.analysisMetadata,
      sessionId: chat.sessionId
    }));

    res.json({
      sessions,
      totalCount: sessions.length
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error getting user analysis sessions:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to retrieve analysis sessions'
    });
  }
};

// Get complete analysis data for a specific chat
export const getAnalysisData = async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const username = requireUsername(req);

    const chatDocument = await getChatDocument(chatId, username);
    
    if (!chatDocument) {
      return res.status(404).json({ error: 'Analysis data not found' });
    }

    // Wave-FA5 · Apply active-filter overlay to rawData / sampleRows so the
    // data preview UI shows what subsequent analyses will see. The canonical
    // dataset on the document is unchanged.
    const rawDataFiltered = applyActiveFilter(chatDocument.rawData ?? [], chatDocument.activeFilter);
    const sampleRowsFiltered = applyActiveFilter(chatDocument.sampleRows ?? [], chatDocument.activeFilter);

    // Return complete analysis data
    res.json({
      id: chatDocument.id,
      fileName: chatDocument.fileName,
      uploadedAt: chatDocument.uploadedAt,
      createdAt: chatDocument.createdAt,
      lastUpdatedAt: chatDocument.lastUpdatedAt,
      collaborators: chatDocument.collaborators || [chatDocument.username],
      dataSummary: chatDocument.dataSummary,
      rawData: rawDataFiltered,
      sampleRows: sampleRowsFiltered,
      // Preview can be generated from rawData.slice(0, 50) on the frontend
      columnStatistics: chatDocument.columnStatistics,
      charts: chatDocument.charts,
      insights: chatDocument.insights || [],
      messages: chatDocument.messages,
      blobInfo: chatDocument.blobInfo,
      analysisMetadata: chatDocument.analysisMetadata,
      sessionId: chatDocument.sessionId,
      activeFilter: chatDocument.activeFilter ?? null,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error getting analysis data:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to retrieve analysis data'
    });
  }
};

// Get analysis data by session ID
export const getAnalysisDataBySession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const username = requireUsername(req);

    const chatDocument = await getChatBySessionIdForUser(sessionId, username);

    if (!chatDocument) {
      return res.status(404).json({ error: 'Analysis data not found for this session' });
    }

    // Wave-FA5 · See parallel comment in getAnalysisData above.
    const rawDataFiltered = applyActiveFilter(chatDocument.rawData ?? [], chatDocument.activeFilter);
    const sampleRowsFiltered = applyActiveFilter(chatDocument.sampleRows ?? [], chatDocument.activeFilter);

    // Return complete analysis data
    res.json({
      id: chatDocument.id,
      fileName: chatDocument.fileName,
      uploadedAt: chatDocument.uploadedAt,
      createdAt: chatDocument.createdAt,
      lastUpdatedAt: chatDocument.lastUpdatedAt,
      collaborators: chatDocument.collaborators || [chatDocument.username],
      dataSummary: chatDocument.dataSummary,
      rawData: rawDataFiltered,
      sampleRows: sampleRowsFiltered,
      // Preview can be generated from rawData.slice(0, 50) on the frontend
      columnStatistics: chatDocument.columnStatistics,
      charts: chatDocument.charts,
      insights: chatDocument.insights || [],
      messages: chatDocument.messages,
      blobInfo: chatDocument.blobInfo,
      analysisMetadata: chatDocument.analysisMetadata,
      sessionId: chatDocument.sessionId,
      activeFilter: chatDocument.activeFilter ?? null,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error getting analysis data by session:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to retrieve analysis data'
    });
  }
};

// Get column statistics for a specific analysis
export const getColumnStatistics = async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const username = requireUsername(req);

    const chatDocument = await getChatDocument(chatId, username);
    
    if (!chatDocument) {
      return res.status(404).json({ error: 'Analysis data not found' });
    }

    res.json({
      chatId: chatDocument.id,
      fileName: chatDocument.fileName,
      columnStatistics: chatDocument.columnStatistics,
      numericColumns: chatDocument.dataSummary.numericColumns,
      totalNumericColumns: Object.keys(chatDocument.columnStatistics).length
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error getting column statistics:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to retrieve column statistics'
    });
  }
};

// Get raw data for a specific analysis (with pagination)
export const getRawData = async (req: Request, res: Response) => {
  try {
    const { chatId } = req.params;
    const username = requireUsername(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;

    const chatDocument = await getChatDocument(chatId, username);
    
    if (!chatDocument) {
      return res.status(404).json({ error: 'Analysis data not found' });
    }

    // Wave-FA5 · paginate AFTER applying the filter so page numbers stay
    // consistent within a filtered view.
    const filteredRows = applyActiveFilter(chatDocument.rawData ?? [], chatDocument.activeFilter);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedData = filteredRows.slice(startIndex, endIndex);

    res.json({
      chatId: chatDocument.id,
      fileName: chatDocument.fileName,
      data: paginatedData,
      pagination: {
        page,
        limit,
        totalRows: filteredRows.length,
        totalPages: Math.ceil(filteredRows.length / limit),
        hasNextPage: endIndex < filteredRows.length,
        hasPrevPage: page > 1
      },
      activeFilter: chatDocument.activeFilter ?? null,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Error getting raw data:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to retrieve raw data'
    });
  }
};
