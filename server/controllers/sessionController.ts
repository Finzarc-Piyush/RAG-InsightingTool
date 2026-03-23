import { Request, Response } from "express";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { 
  getAllSessions, 
  getAllSessionsPaginated, 
  getSessionsWithFilters, 
  getSessionStatistics,
  getChatBySessionIdForUser,
  deleteSessionBySessionId,
  updateSessionFileName,
  updateSessionPermanentContext,
  ChatDocument 
} from "../models/chat.model.js";
import { loadChartsFromBlob } from "../lib/blobStorage.js";
import { loadLatestData } from "../utils/dataLoader.js";
import { getDataSummary } from "../lib/dataOps/pythonService.js";
import { generateAISuggestions } from "../lib/suggestionGenerator.js";

// Get all sessions
export const getAllSessionsEndpoint = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);

    const sessions = await getAllSessions(username);
    
    // Return simplified session list for better performance
    const sessionList = sessions.map(session => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({ 
      sessions: sessionList, 
      count: sessionList.length,
      message: `Retrieved ${sessionList.length} sessions for user: ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Get all sessions error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch all sessions';
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage,
    });
  }
};

// Get sessions with pagination
export const getSessionsPaginatedEndpoint = async (req: Request, res: Response) => {
  try {
    const pageSize = parseInt(req.query.pageSize as string) || 10;
    const continuationToken = req.query.continuationToken as string;
    
    const username = requireUsername(req);

    const result = await getAllSessionsPaginated(pageSize, continuationToken, username);
    
    // Return simplified session list
    const sessionList = result.sessions.map(session => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      continuationToken: result.continuationToken,
      hasMoreResults: result.hasMoreResults,
      pageSize,
      message: `Retrieved ${sessionList.length} sessions (page size: ${pageSize}) for user: ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Get paginated sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch paginated sessions',
    });
  }
};

// Get sessions with filters
export const getSessionsFilteredEndpoint = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const {
      fileName,
      dateFrom,
      dateTo,
      limit,
      orderBy,
      orderDirection
    } = req.query;

    const options: {
      username?: string;
      fileName?: string;
      dateFrom?: number;
      dateTo?: number;
      limit?: number;
      orderBy?: 'createdAt' | 'lastUpdatedAt' | 'uploadedAt';
      orderDirection?: 'ASC' | 'DESC';
    } = {};

    options.username = authed;
    if (fileName) options.fileName = fileName as string;
    if (dateFrom) options.dateFrom = parseInt(dateFrom as string);
    if (dateTo) options.dateTo = parseInt(dateTo as string);
    if (limit) options.limit = parseInt(limit as string);
    if (orderBy) options.orderBy = orderBy as 'createdAt' | 'lastUpdatedAt' | 'uploadedAt';
    if (orderDirection) options.orderDirection = orderDirection as 'ASC' | 'DESC';

    const sessions = await getSessionsWithFilters(options);
    
    // Return simplified session list
    const sessionList = sessions.map(session => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      filters: options,
      message: `Retrieved ${sessionList.length} sessions with filters`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Get filtered sessions error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch filtered sessions',
    });
  }
};

// Get session statistics
export const getSessionStatisticsEndpoint = async (req: Request, res: Response) => {
  try {
    requireUsername(req);
    const stats = await getSessionStatistics();
    
    res.json({
      statistics: stats,
      message: `Generated statistics for ${stats.totalSessions} sessions`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Get session statistics error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch session statistics',
    });
  }
};

// Get detailed session by session ID (efficient)
export const getSessionDetailsEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const normalizedRequesterEmail = requireUsername(req);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get session directly from CosmosDB by session ID with access check
    try {
      const session = await getChatBySessionIdForUser(sessionId, normalizedRequesterEmail);
      
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Load charts from blob storage if they're stored there
      let chartsWithData = session.charts || [];
      if (session.chartReferences && session.chartReferences.length > 0) {
        try {
          const chartsFromBlob = await loadChartsFromBlob(session.chartReferences);
          // Merge charts from blob with charts in CosmosDB (charts in CosmosDB may have metadata only)
          // Use charts from blob if available, otherwise use charts from CosmosDB
          if (chartsFromBlob.length > 0) {
            chartsWithData = chartsFromBlob;
            console.log(`✅ Loaded ${chartsFromBlob.length} charts from blob storage`);
          }
        } catch (blobError) {
          console.error('⚠️ Failed to load charts from blob, using charts from CosmosDB:', blobError);
          // Continue with charts from CosmosDB (may not have data arrays)
        }
      }

      // Build a lookup map: chart title+type -> full chart with data
      // This allows us to enrich message charts with data from top-level charts
      const chartLookup = new Map<string, any>();
      chartsWithData.forEach(chart => {
        if (chart.title && chart.type) {
          const key = `${chart.type}::${chart.title}`;
          chartLookup.set(key, chart);
        }
      });

      // Also check charts in CosmosDB that might have data (for small charts not in blob)
      (session.charts || []).forEach(chart => {
        if (chart.title && chart.type && chart.data) {
          const key = `${chart.type}::${chart.title}`;
          if (!chartLookup.has(key)) {
            chartLookup.set(key, chart);
          }
        }
      });

      // Enrich message charts with data from top-level charts
      const enrichedMessages = (session.messages || []).map(msg => {
        if (!msg.charts || msg.charts.length === 0) {
          return msg;
        }

        const enrichedCharts = msg.charts.map(chart => {
          const key = `${chart.type}::${chart.title}`;
          const fullChart = chartLookup.get(key);
          
          if (fullChart && fullChart.data) {
            // Merge metadata from message chart with data from top-level chart
            return {
              ...chart,
              data: fullChart.data,
              trendLine: fullChart.trendLine,
              xDomain: fullChart.xDomain,
              yDomain: fullChart.yDomain,
            };
          }
          
          // If no match found, return chart as-is (might have data already or be a small chart)
          return chart;
        });

        return {
          ...msg,
          charts: enrichedCharts,
        };
      });

      console.log(`✅ Enriched ${enrichedMessages.length} messages with chart data`);

      // Return session with charts loaded from blob and messages enriched with chart data
      const sessionWithCharts = {
        ...session,
        charts: chartsWithData,
        messages: enrichedMessages,
      };

      res.json({
        session: sessionWithCharts,
        message: `Retrieved session details for ${sessionId}`
      });
    } catch (accessError: any) {
      // Handle authorization errors separately
      if (accessError?.statusCode === 403) {
        console.warn(`⚠️ Unauthorized access attempt: ${normalizedRequesterEmail} tried to access session ${sessionId}`);
        return res.status(403).json({ 
          error: 'Unauthorized to access this session',
          message: 'You do not have permission to access this session'
        });
      }
      // Re-throw if it's not an authorization error
      throw accessError;
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Get session details error:', error);
    const statusCode = (error as any)?.statusCode || 500;
    res.status(statusCode).json({
      error: error instanceof Error ? error.message : 'Failed to fetch session details',
    });
  }
};

// Get sessions by user
export const getSessionsByUserEndpoint = async (req: Request, res: Response) => {
  try {
    const authed = requireUsername(req);
    const { username } = req.params;
    const pathUser = decodeURIComponent(username || "").trim().toLowerCase();
    
    if (!pathUser) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (pathUser !== authed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const sessions = await getSessionsWithFilters({ username: pathUser });
    
    // Return simplified session list
    const sessionList = sessions.map(session => ({
      id: session.id,
      username: session.username,
      fileName: session.fileName,
      uploadedAt: session.uploadedAt,
      createdAt: session.createdAt,
      lastUpdatedAt: session.lastUpdatedAt,
      collaborators: session.collaborators || [session.username],
      messageCount: session.messages.length,
      chartCount: session.charts.length,
      sessionId: session.sessionId,
    }));

    res.json({
      sessions: sessionList,
      count: sessionList.length,
      username,
      message: `Retrieved ${sessionList.length} sessions for user ${username}`
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error('Get sessions by user error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch sessions by user',
    });
  }
};

// Update session fileName by session ID
export const updateSessionNameEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { fileName } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    if (!fileName || typeof fileName !== 'string' || fileName.trim().length === 0) {
      return res.status(400).json({ error: 'File name is required' });
    }

    const username = requireUsername(req);

    // Update the session fileName
    const updatedSession = await updateSessionFileName(sessionId, username, fileName.trim());
    
    res.json({
      success: true,
      message: `Session name updated successfully`,
      session: {
        id: updatedSession.id,
        sessionId: updatedSession.sessionId,
        fileName: updatedSession.fileName,
        lastUpdatedAt: updatedSession.lastUpdatedAt,
      }
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Update session name error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update session name';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's an unauthorized error
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};

// Update session permanent context by session ID
export const updateSessionContextEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { permanentContext } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    if (permanentContext === undefined || (typeof permanentContext !== 'string' && permanentContext !== null)) {
      return res.status(400).json({ error: 'Permanent context must be a string or null' });
    }

    const username = requireUsername(req);

    // Update the session permanent context
    const updatedSession = await updateSessionPermanentContext(
      sessionId, 
      username, 
      permanentContext || ''
    );
    
    res.json({
      success: true,
      message: `Session context updated successfully`,
      session: {
        id: updatedSession.id,
        sessionId: updatedSession.sessionId,
        permanentContext: updatedSession.permanentContext,
        lastUpdatedAt: updatedSession.lastUpdatedAt,
      }
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Update session context error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update session context';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's an unauthorized error
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};

// Get data summary for a session
export const getDataSummaryEndpoint = async (req: Request, res: Response) => {
  try {
    console.log('📊 getDataSummaryEndpoint called', { 
      sessionId: req.params.sessionId,
      path: req.path,
      method: req.method 
    });
    
    const { sessionId } = req.params;
    const username = requireUsername(req);
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    // Get session document
    const session = await getChatBySessionIdForUser(sessionId, username);
    
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.dataSummary) {
      return res.status(404).json({ error: 'Data summary not available for this session' });
    }

    // Check if we have pre-computed data summary statistics (from upload)
    if (session.dataSummaryStatistics && session.dataSummaryStatistics.summary) {
      console.log('✅ Using pre-computed data summary statistics from upload');
      
      // Generate recommended questions
      const chatHistory = session.messages || [];
      const lastAnswer = chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant'
        ? chatHistory[chatHistory.length - 1].content
        : undefined;
      
      let recommendedQuestions: string[] = [];
      try {
        recommendedQuestions = await generateAISuggestions(
          chatHistory,
          session.dataSummary,
          lastAnswer
        );
      } catch (error) {
        console.error('Failed to generate AI suggestions:', error);
        // Fallback to default suggestions
        if (session.dataSummary.numericColumns.length > 0) {
          recommendedQuestions = [
            `What affects ${session.dataSummary.numericColumns[0]}?`,
            `Show me trends for ${session.dataSummary.numericColumns[0]}`,
            'What are the top performers?',
            'Analyze correlations in the data'
          ];
        } else {
          recommendedQuestions = [
            'Show me trends over time',
            'What are the top performers?',
            'Analyze the data',
            'What patterns do you see?'
          ];
        }
      }

      return res.json({
        summary: session.dataSummaryStatistics.summary,
        qualityScore: session.dataSummaryStatistics.qualityScore,
        recommendedQuestions,
      });
    }

    // Fallback: Compute on-demand if not pre-computed
    console.log('⚠️ No pre-computed data summary found, computing on-demand...');
    
    // Load latest data (including any modifications from data operations)
    let data = await loadLatestData(session);
    
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'No data available for this session' });
    }

    // For large datasets, sample the data before sending to Python service
    // Python service has limits and sending 200k+ rows causes timeouts
    const MAX_ROWS_FOR_SUMMARY = 50000; // Limit to 50k rows for summary calculation
    if (data.length > MAX_ROWS_FOR_SUMMARY) {
      console.log(`📊 Dataset has ${data.length} rows, sampling ${MAX_ROWS_FOR_SUMMARY} rows for summary calculation`);
      
      // Use stratified sampling: take evenly spaced rows to get a representative sample
      const step = Math.floor(data.length / MAX_ROWS_FOR_SUMMARY);
      const sampledData: Record<string, any>[] = [];
      for (let i = 0; i < data.length && sampledData.length < MAX_ROWS_FOR_SUMMARY; i += step) {
        sampledData.push(data[i]);
      }
      data = sampledData;
      console.log(`✅ Sampled ${data.length} rows for summary calculation`);
    }

    // Get summary statistics from Python service
    const summaryResponse = await getDataSummary(data);
    
    // Calculate quality score based on null values
    // Scale statistics to full dataset size (if we sampled the data)
    const fullDataRowCount = session.dataSummary?.rowCount || data.length;
    
    // Calculate total cells and nulls for quality score
    const totalCells = summaryResponse.summary.reduce((sum, col) => sum + fullDataRowCount, 0);
    const totalNulls = summaryResponse.summary.reduce((sum, col) => {
      // Scale null count proportionally
      const nullPercentage = col.total_values > 0 ? col.null_values / col.total_values : 0;
      return sum + Math.round(nullPercentage * fullDataRowCount);
    }, 0);
    const nullPercentage = totalCells > 0 ? (totalNulls / totalCells) * 100 : 0;
    const qualityScore = Math.max(0, Math.round(100 - nullPercentage));
    
    // Scale summary statistics to full dataset size for display
    // Statistical measures (mean, median, std_dev, min, max) remain the same from sample
    // Only scale counts (total_values, null_values, non_null_values)
    const scaledSummary = summaryResponse.summary.map(col => {
      const nullPercentage = col.total_values > 0 ? col.null_values / col.total_values : 0;
      const scaledNulls = Math.round(nullPercentage * fullDataRowCount);
      return {
        ...col,
        total_values: fullDataRowCount,
        null_values: scaledNulls,
        non_null_values: fullDataRowCount - scaledNulls,
      };
    });

    // Generate recommended questions
    const chatHistory = session.messages || [];
    const lastAnswer = chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant'
      ? chatHistory[chatHistory.length - 1].content
      : undefined;
    
    let recommendedQuestions: string[] = [];
    try {
      recommendedQuestions = await generateAISuggestions(
        chatHistory,
        session.dataSummary,
        lastAnswer
      );
    } catch (error) {
      console.error('Failed to generate AI suggestions:', error);
      // Fallback to default suggestions
      if (session.dataSummary.numericColumns.length > 0) {
        recommendedQuestions = [
          `What affects ${session.dataSummary.numericColumns[0]}?`,
          `Show me trends for ${session.dataSummary.numericColumns[0]}`,
          'What are the top performers?',
          'Analyze correlations in the data'
        ];
      } else {
        recommendedQuestions = [
          'Show me trends over time',
          'What are the top performers?',
          'Analyze the data',
          'What patterns do you see?'
        ];
      }
    }

    res.json({
      summary: scaledSummary,
      qualityScore,
      recommendedQuestions,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Get data summary error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to fetch data summary';
    
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({ error: errorMessage });
    }
    
    if (errorMessage.includes('Unauthorized')) {
      return res.status(403).json({ error: errorMessage });
    }
    
    res.status(500).json({ error: errorMessage });
  }
};

// Delete session by session ID
export const deleteSessionEndpoint = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }

    const username = requireUsername(req);

    // Delete the session
    await deleteSessionBySessionId(sessionId, username);
    
    res.json({
      success: true,
      message: `Session ${sessionId} deleted successfully`,
      sessionId
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Delete session error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to delete session';
    
    // Check if it's a "not found" error
    if (errorMessage.includes('not found') || errorMessage.includes('Session not found')) {
      return res.status(404).json({
        error: errorMessage
      });
    }
    
    // Check if it's a CosmosDB initialization error
    if (errorMessage.includes('not initialized')) {
      return res.status(503).json({
        error: 'Database is initializing. Please try again in a moment.',
        retryAfter: 2
      });
    }
    
    res.status(500).json({
      error: errorMessage
    });
  }
};
