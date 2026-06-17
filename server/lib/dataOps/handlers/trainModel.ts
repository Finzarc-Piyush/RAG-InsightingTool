/**
 * `train_model` data-op handler — extracted VERBATIM from `executeDataOperation`'s
 * switch (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Resolves ML model parameters (from intent, prior-turn context, or — only when
 * still missing — an AI extraction), matches the target/feature columns, runs a
 * data-quality gate, then delegates training to the Python service
 * (`trainMLModel`) and formats the textual report. ML models do NOT modify the
 * dataset, so this handler does NOT persist and does NOT mutate the chat
 * document (`saved: false`).
 *
 * The three private helpers used ONLY by this branch — `extractPreviousModelParams`,
 * `extractMLModelDetails`, `formatMLModelResponse` — are moved here UNCHANGED
 * alongside the branch body. The only change vs. the orchestrator is collapsing
 * the captured locals into a single typed args object (CQ-2). Same dynamic
 * `columnMatcher.js` import, same pythonService call, same answer strings, same
 * return shape.
 */
import { Message } from "../../../shared/schema.js";
import { trainMLModel } from "../pythonService.js";
import type { TrainModelResponse } from "../pythonService.js";
import { callLlm } from "../../agents/runtime/callLlm.js";
import { LLM_PURPOSE } from "../../agents/runtime/llmCallPurpose.js";
import { logger } from "../../logger.js";
import type { ChatDocument } from "../../../models/chat.model.js";
import type { DataRow, DataOpResult } from "../dataOpsTypes.js";
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";

export interface TrainModelArgs {
  intent: DataOpsIntent;
  data: DataRow[];
  sessionDoc?: ChatDocument;
  originalMessage?: string;
  chatHistory?: Message[];
}

export async function handleTrainModel({
  intent,
  data,
  sessionDoc,
  originalMessage,
  chatHistory,
}: TrainModelArgs): Promise<DataOpResult> {
  // Extract model parameters from intent or use AI to extract from message
  let modelType: 'linear' | 'log_log' | 'logistic' | 'ridge' | 'lasso' | 'random_forest' | 'decision_tree' | 'gradient_boosting' | 'elasticnet' | 'svm' | 'knn' | 'polynomial' | 'bayesian' | 'quantile' | 'poisson' | 'gamma' | 'tweedie' | 'extra_trees' | 'xgboost' | 'lightgbm' | 'catboost' | 'gaussian_process' | 'mlp' | 'multinomial_logistic' | 'naive_bayes_gaussian' | 'naive_bayes_multinomial' | 'naive_bayes_bernoulli' | 'lda' | 'qda' = intent.modelType || 'linear';
  let targetVariable = intent.targetVariable;
  let features = intent.features || [];

  // Get chat history to look for previous model parameters
  // Use passed chatHistory first, fallback to sessionDoc messages if available
  let chatHistoryForContext: Message[] = [];
  try {
    chatHistoryForContext = chatHistory || sessionDoc?.messages || [];
  } catch (error) {
    // If accessing sessionDoc.messages fails (e.g., CosmosDB not initialized), use empty array
    logger.warn('⚠️ Could not access chat history, continuing without context:', error);
    chatHistoryForContext = chatHistory || [];
  }

  const previousModelParams = extractPreviousModelParams(chatHistoryForContext);

  if (previousModelParams) {
    logger.log(`✅ Found previous model context: target="${previousModelParams.targetVariable}", features=[${previousModelParams.features?.join(', ')}], type=${previousModelParams.modelType || 'unknown'}`);
  } else {
    logger.log(`⚠️ No previous model context found in ${chatHistoryForContext.length} messages`);
  }

  // Check if user wants less variance (Ridge/Lasso)
  const messageText = originalMessage || sessionDoc?.messages?.slice().reverse().find(m => m.role === 'user')?.content || '';
  const messageLower = messageText.toLowerCase();
  const wantsLessVariance = messageLower.includes('less variance') ||
                            messageLower.includes('reduce variance') ||
                            messageLower.includes('lower variance');

  logger.log(`📝 Processing model request: message="${messageText}", wantsLessVariance=${wantsLessVariance}, hasPreviousParams=${!!previousModelParams}`);

  // If user wants less variance and we have previous model, default to Ridge
  if (wantsLessVariance && previousModelParams && !intent.modelType) {
    modelType = 'ridge';
    logger.log(`🎯 User wants less variance, using Ridge model`);
    // Also use previous model params if not provided
    if (!targetVariable && previousModelParams.targetVariable) {
      targetVariable = previousModelParams.targetVariable;
      logger.log(`📋 Using previous target variable: ${targetVariable}`);
    }
    if (features.length === 0 && previousModelParams.features && previousModelParams.features.length > 0) {
      features = previousModelParams.features;
      logger.log(`📋 Using previous features: ${features.join(', ')}`);
    }
  }

  // If not provided, try to extract from message using AI
  if (!targetVariable || features.length === 0) {
    const availableColumns = sessionDoc?.dataSummary?.columns?.map(c => c.name) || Object.keys(data[0] || {});

    // Use AI to extract ML model parameters with context
    const extraction = await extractMLModelDetails(messageText, availableColumns, chatHistoryForContext, previousModelParams || undefined);
    if (extraction) {
      modelType = extraction.modelType || modelType;
      targetVariable = targetVariable || extraction.targetVariable;
      features = features.length > 0 ? features : (extraction.features || []);
    }

    // If still missing and we have previous model params, use them (strong fallback)
    if ((!targetVariable || features.length === 0) && previousModelParams) {
      logger.log(`📋 Using previous model parameters from chat history as fallback`);
      targetVariable = targetVariable || previousModelParams.targetVariable;
      features = features.length > 0 ? features : (previousModelParams.features || []);
    }
  }

  if (!targetVariable) {
    return {
      answer: 'Please specify the target variable (dependent variable) for the model. For example: "Build a linear model choosing Sales as target variable and Price, Marketing as independent variables"'
    };
  }

  if (features.length === 0) {
    return {
      answer: 'Please specify the features (independent variables) for the model. For example: "Build a linear model choosing Sales as target variable and Price, Marketing as independent variables"'
    };
  }

  // Find matching columns
  const allColumns = sessionDoc?.dataSummary?.columns?.map(c => c.name) || Object.keys(data[0] || {});
  const { findMatchingColumn } = await import('../../agents/utils/columnMatcher.js');

  const targetCol = findMatchingColumn(targetVariable, allColumns);
  if (!targetCol) {
    return {
      answer: `Could not find column matching "${targetVariable}". Available columns: ${allColumns.slice(0, 10).join(', ')}${allColumns.length > 10 ? '...' : ''}`
    };
  }

  const matchedFeatures = features
    .map(f => findMatchingColumn(f, allColumns))
    .filter((f): f is string => f !== null && f !== targetCol);

  if (matchedFeatures.length === 0) {
    return {
      answer: `Could not match any features to columns. Available columns: ${allColumns.slice(0, 10).join(', ')}${allColumns.length > 10 ? '...' : ''}`
    };
  }

  // Diagnostic: Check data quality before training
  if (data.length === 0) {
    return {
      answer: 'No data available for model training. Please ensure your dataset has been loaded correctly.'
    };
  }

  // Check for null values in target and features
  const targetNulls = data.filter(row => row[targetCol] === null || row[targetCol] === undefined || row[targetCol] === '').length;
  const featureNulls = matchedFeatures.map(f => ({
    feature: f,
    nulls: data.filter(row => row[f] === null || row[f] === undefined || row[f] === '').length
  }));

  logger.log(`📊 Data quality check: Total rows=${data.length}, Target nulls=${targetNulls}, Feature nulls:`, featureNulls);

  if (targetNulls === data.length) {
    return {
      answer: `Cannot train model: Target variable "${targetCol}" has no valid values (all ${data.length} rows are null/empty). Please check your data.`
    };
  }

  const allFeaturesNull = featureNulls.every(f => f.nulls === data.length);
  if (allFeaturesNull) {
    return {
      answer: `Cannot train model: All features have no valid values (all ${data.length} rows are null/empty). Please check your data.`
    };
  }

  try {
    // Train the model
    const modelResult = await trainMLModel(
      data,
      modelType,
      targetCol,
      matchedFeatures
    );

    // Format response
    const answer = formatMLModelResponse(modelResult, modelType, targetCol, matchedFeatures);

    return {
      answer,
      saved: false // ML models don't modify data
    };
  } catch (error) {
    logger.error('ML model training error:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Provide helpful error message
    let helpfulMessage = `Error training model: ${errorMessage}`;
    if (errorMessage.includes('No valid data rows')) {
      helpfulMessage += `\n\nThis usually means:\n` +
        `- The target variable "${targetCol}" or features have too many null values\n` +
        `- After removing rows with null targets, no rows remain with valid feature values\n` +
        `- Try checking your data: "Count nulls in ${targetCol}" or "Show me the data"`;
    }

    return {
      answer: helpfulMessage
    };
  }
}

// ---------------------------------------------------------------------------
// Private helpers — moved VERBATIM from `dataOpsOrchestrator.ts`; used ONLY by
// the train_model branch above.
// ---------------------------------------------------------------------------

function extractPreviousModelParams(chatHistory: Message[]): { targetVariable?: string; features?: string[]; modelType?: string } | null {
  if (!chatHistory || chatHistory.length === 0) {
    logger.log('📋 No chat history provided for context extraction');
    return null;
  }

  logger.log(`📋 Searching through ${chatHistory.length} messages for previous model context`);

  // Look backwards through chat history for the most recent model result
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const msg = chatHistory[i]!;
    if (msg.role === 'assistant' && msg.content) {
      const content = msg.content;

      // Check if this is a model result (contains "Model Summary" and "Target Variable")
      if (content.includes('Model Summary') && content.includes('Target Variable')) {
        logger.log(`📋 Found potential model result at message index ${i}`);

        // Try multiple patterns for target variable (handle markdown format with dashes)
        const targetMatch = content.match(/[-*]\s*Target Variable:\s*([^\n]+)/i) ||
                           content.match(/Target Variable:\s*([^\n]+)/i) ||
                           content.match(/target[:\s]+([^\n]+)/i);

        // Try multiple patterns for features (handle markdown format with dashes)
        const featuresMatch = content.match(/[-*]\s*Features:\s*([^\n]+)/i) ||
                             content.match(/Features:\s*([^\n]+)/i) ||
                             content.match(/features[:\s]+([^\n]+)/i);

        // Try multiple patterns for model type
        const modelTypeMatch = content.match(/trained a (\w+(?:\s+\w+)?)\s+model/i) ||
                              content.match(/successfully trained a (\w+(?:\s+\w+)?)\s+model/i) ||
                              content.match(/(\w+(?:\s+\w+)?)\s+model/i) ||
                              content.match(/model type[:\s]+(\w+(?:\s+\w+)?)/i);

        if (targetMatch && featuresMatch) {
          const targetVariable = targetMatch[1]!.trim();
          const featuresStr = featuresMatch[1]!.trim();
          // Parse features (comma-separated list, handle "&" and "and")
          const features = featuresStr
            .split(/[,&]| and /i)
            .map(f => f.trim())
            .filter(f => f.length > 0);

          let modelType: string | undefined;
          if (modelTypeMatch) {
            let modelTypeStr = modelTypeMatch[1]!.trim().toLowerCase();
            // Normalize model type names
            modelTypeStr = modelTypeStr.replace(/\s+/g, '_');
            // Handle variations
            if (modelTypeStr.includes('random') && modelTypeStr.includes('forest')) {
              modelTypeStr = 'random_forest';
            } else if (modelTypeStr.includes('decision') && modelTypeStr.includes('tree')) {
              modelTypeStr = 'decision_tree';
            }

            if (['linear', 'logistic', 'ridge', 'lasso', 'random_forest', 'decision_tree'].includes(modelTypeStr)) {
              modelType = modelTypeStr;
            }
          }

          logger.log(`✅ Found previous model in chat history: target="${targetVariable}", features=[${features.join(', ')}], type=${modelType || 'unknown'}`);
          return { targetVariable, features, modelType };
        } else {
          logger.log(`⚠️ Found model result but couldn't parse: targetMatch=${!!targetMatch}, featuresMatch=${!!featuresMatch}`);
        }
      }
    }
  }

  logger.log('📋 No previous model found in chat history');
  return null;
}

/**
 * Extract ML model details using AI
 */
async function extractMLModelDetails(
  message: string,
  availableColumns: string[],
  chatHistory?: Message[],
  previousModelParams?: { targetVariable?: string; features?: string[]; modelType?: string }
): Promise<{ modelType?: 'linear' | 'log_log' | 'logistic' | 'ridge' | 'lasso' | 'random_forest' | 'decision_tree' | 'gradient_boosting' | 'elasticnet' | 'svm' | 'knn' | 'polynomial' | 'bayesian' | 'quantile' | 'poisson' | 'gamma' | 'tweedie' | 'extra_trees' | 'xgboost' | 'lightgbm' | 'catboost' | 'gaussian_process' | 'mlp' | 'multinomial_logistic' | 'naive_bayes_gaussian' | 'naive_bayes_multinomial' | 'naive_bayes_bernoulli' | 'lda' | 'qda'; targetVariable?: string; features?: string[] } | null> {
  try {
    const columnsList = availableColumns.slice(0, 30).join(', ');

    // Build context about previous model if available
    let previousModelContext = '';
    if (previousModelParams && previousModelParams.targetVariable) {
      previousModelContext = `\n\nPREVIOUS MODEL CONTEXT (if user references "for above", "that model", etc., use these parameters):\n`;
      previousModelContext += `- Target Variable: ${previousModelParams.targetVariable}\n`;
      previousModelContext += `- Features: ${previousModelParams.features?.join(', ') || 'N/A'}\n`;
      if (previousModelParams.modelType) {
        previousModelContext += `- Previous Model Type: ${previousModelParams.modelType}\n`;
      }
    }

    // Check if user is referencing previous model
    const messageLower = message.toLowerCase();
    const referencesPrevious = messageLower.includes('for above') ||
                               messageLower.includes('for the above') ||
                               messageLower.includes('that model') ||
                               messageLower.includes('previous model') ||
                               messageLower.includes('the above') ||
                               messageLower.includes('above model') ||
                               (messageLower.includes('same') && messageLower.includes('model')) ||
                               (messageLower.includes('less variance') && previousModelParams) ||
                               (messageLower.includes('reduce variance') && previousModelParams);

    // Determine model type based on user request
    let suggestedModelType = 'linear';
    if (messageLower.includes('log') && (messageLower.includes('log log') || messageLower.includes('log-log') || messageLower.includes('logarithmic'))) {
      suggestedModelType = 'log_log';
    } else if (messageLower.includes('less variance') || messageLower.includes('reduce variance') || messageLower.includes('lower variance')) {
      // Ridge or Lasso for variance reduction
      suggestedModelType = 'ridge'; // Default to Ridge for variance reduction
    } else if (messageLower.includes('ridge')) {
      suggestedModelType = 'ridge';
    } else if (messageLower.includes('lasso')) {
      suggestedModelType = 'lasso';
    } else if (messageLower.includes('random forest') || messageLower.includes('randomforest')) {
      suggestedModelType = 'random_forest';
    } else if (messageLower.includes('decision tree') || messageLower.includes('decisiontree')) {
      suggestedModelType = 'decision_tree';
    } else if (messageLower.includes('logistic')) {
      suggestedModelType = 'logistic';
    }

    const prompt = `Extract ML model parameters from the user's query.${previousModelContext}

User query: "${message}"

Available columns: ${columnsList}

${referencesPrevious && previousModelParams ? 'IMPORTANT: The user is referencing a previous model. Use the previous model parameters (target variable and features) from the context above unless they explicitly specify different ones.' : ''}

Extract:
1. modelType: "linear", "log_log", "logistic", "ridge", "lasso", "random_forest", "decision_tree", "gradient_boosting", "elasticnet", "svm", "knn", "polynomial", "bayesian", etc.
   ${messageLower.includes('less variance') || messageLower.includes('reduce variance') ? '   → If user wants "less variance", use "ridge" or "lasso" (prefer "ridge")' : ''}
   ${messageLower.includes('log') && (messageLower.includes('log') || messageLower.includes('logarithmic')) ? '   → If user mentions "log log", "log-log", or "logarithmic" model, use "log_log"' : ''}
   ${suggestedModelType !== 'linear' ? `   → Suggested: "${suggestedModelType}" based on user query` : ''}
2. targetVariable: The target/dependent variable to predict
   ${referencesPrevious && previousModelParams?.targetVariable ? `   → If referencing previous model, use: "${previousModelParams.targetVariable}"` : ''}
3. features: Array of independent variables/features
   ${referencesPrevious && previousModelParams?.features ? `   → If referencing previous model, use: [${previousModelParams.features.map(f => `"${f}"`).join(', ')}]` : ''}

Examples:
- "Build a linear model choosing Sales as target variable and Price, Marketing as independent variables"
  → modelType: "linear", targetVariable: "Sales", features: ["Price", "Marketing"]
- "for above can you choose a model with less variance" (when previous model had Target: Sales, Features: Price, Marketing)
  → modelType: "ridge", targetVariable: "Sales", features: ["Price", "Marketing"]
- "Create a linear model with PA TOM as target and PA nGRP Adstocked, PAB nGRP Adstocked as features"
  → modelType: "linear", targetVariable: "PA TOM", features: ["PA nGRP Adstocked", "PAB nGRP Adstocked"]
- "Train a random forest model to predict Revenue using Price, Marketing, Season"
  → modelType: "random_forest", targetVariable: "Revenue", features: ["Price", "Marketing", "Season"]

Return JSON:
{
  "modelType": "linear" | "log_log" | "logistic" | "ridge" | "lasso" | "random_forest" | "decision_tree" | "gradient_boosting" | "elasticnet" | "svm" | "knn" | "polynomial" | "bayesian" | etc.,
  "targetVariable": "ColumnName",
  "features": ["Column1", "Column2", "Column3"]
}`;

    const response = await callLlm(
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You extract ML model parameters from natural language. Return only valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300,
      },
      { purpose: LLM_PURPOSE.DATAOPS_ML_PARAMS }
    );

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.targetVariable && parsed.features && Array.isArray(parsed.features)) {
      return {
        modelType: parsed.modelType || 'linear',
        targetVariable: parsed.targetVariable.trim(),
        features: parsed.features.map((f: string) => f.trim()).filter((f: string) => f.length > 0),
      };
    }

    return null;
  } catch (error) {
    logger.error('Error extracting ML model details:', error);
    return null;
  }
}

/**
 * Format ML model response
 */
function formatMLModelResponse(
  result: TrainModelResponse,
  modelType: string,
  targetCol: string,
  features: string[]
): string {
  let answer = `I've successfully trained a ${modelType.replace('_', ' ')} model.\n\n`;

  answer += `**Model Summary:**\n`;
  answer += `- Target Variable: ${targetCol}\n`;
  answer += `- Features: ${features.join(', ')}\n`;
  answer += `- Training Samples: ${result.n_train}\n`;
  answer += `- Test Samples: ${result.n_test}\n\n`;

  // Add metrics
  answer += `**Model Performance:**\n`;

  if (result.task_type === 'regression') {
    const testMetrics = result.metrics.test;
    answer += `- R² Score: ${testMetrics.r2_score?.toFixed(4) || 'N/A'}\n`;
    answer += `- RMSE: ${testMetrics.rmse?.toFixed(4) || 'N/A'}\n`;
    answer += `- MAE: ${testMetrics.mae?.toFixed(4) || 'N/A'}\n`;

    if (result.metrics.cross_validation?.mean_r2) {
      answer += `- Cross-Validation R² (mean): ${result.metrics.cross_validation.mean_r2.toFixed(4)}\n`;
    }
  } else {
    const testMetrics = result.metrics.test;
    answer += `- Accuracy: ${(testMetrics.accuracy! * 100)?.toFixed(2) || 'N/A'}%\n`;
    answer += `- Precision: ${(testMetrics.precision! * 100)?.toFixed(2) || 'N/A'}%\n`;
    answer += `- Recall: ${(testMetrics.recall! * 100)?.toFixed(2) || 'N/A'}%\n`;
    answer += `- F1 Score: ${(testMetrics.f1_score! * 100)?.toFixed(2) || 'N/A'}%\n`;

    if (result.metrics.cross_validation?.mean_accuracy) {
      answer += `- Cross-Validation Accuracy (mean): ${(result.metrics.cross_validation.mean_accuracy * 100).toFixed(2)}%\n`;
    }
  }

  answer += `\n`;

  // Add coefficients for linear models
  if (result.coefficients) {
    answer += `**Model Coefficients:**\n`;
    answer += `- Intercept: ${typeof result.coefficients.intercept === 'number' ? result.coefficients.intercept.toFixed(4) : 'N/A'}\n`;

    if (result.coefficients.features) {
      const featureCoefs = Object.entries(result.coefficients.features)
        .sort((a, b) => {
          const aVal = typeof a[1] === 'number' ? Math.abs(a[1]) : 0;
          const bVal = typeof b[1] === 'number' ? Math.abs(b[1]) : 0;
          return bVal - aVal;
        });

      for (const [feature, coef] of featureCoefs) {
        const coefValue = typeof coef === 'number' ? coef.toFixed(4) : 'N/A';
        answer += `- ${feature}: ${coefValue}\n`;
      }
    }
    answer += `\n`;
  }

  // Add feature importance for tree-based models
  if (result.feature_importance) {
    answer += `**Feature Importance:**\n`;
    const importanceEntries = Object.entries(result.feature_importance)
      .sort((a, b) => (b[1] as number) - (a[1] as number));

    for (const [feature, importance] of importanceEntries) {
      answer += `- ${feature}: ${(importance as number).toFixed(4)}\n`;
    }
    answer += `\n`;
  }

  // Add insights
  answer += `**Key Insights:**\n`;
  if (result.task_type === 'regression') {
    const r2 = result.metrics.test.r2_score!;
    if (r2 > 0.8) {
      answer += `- The model explains ${(r2 * 100).toFixed(1)}% of the variance, indicating excellent fit.\n`;
    } else if (r2 > 0.6) {
      answer += `- The model explains ${(r2 * 100).toFixed(1)}% of the variance, indicating good fit.\n`;
    } else if (r2 > 0.4) {
      answer += `- The model explains ${(r2 * 100).toFixed(1)}% of the variance, indicating moderate fit.\n`;
    } else {
      answer += `- The model explains ${(r2 * 100).toFixed(1)}% of the variance, indicating poor fit. Consider feature engineering or different model types.\n`;
    }
  } else {
    const accuracy = result.metrics.test.accuracy!;
    if (accuracy > 0.9) {
      answer += `- The model achieves ${(accuracy * 100).toFixed(1)}% accuracy, indicating excellent performance.\n`;
    } else if (accuracy > 0.7) {
      answer += `- The model achieves ${(accuracy * 100).toFixed(1)}% accuracy, indicating good performance.\n`;
    } else {
      answer += `- The model achieves ${(accuracy * 100).toFixed(1)}% accuracy. Consider feature engineering or different model types.\n`;
    }
  }

  return answer;
}
