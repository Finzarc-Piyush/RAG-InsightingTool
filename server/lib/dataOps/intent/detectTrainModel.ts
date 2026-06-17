/**
 * `detectTrainModel` — STEP 2 model blocks of `parseDataOpsIntent`'s regex
 * fallback chain (ARCH-2 / CQ-2). Behaviour-preserving move, lifted VERBATIM and
 * kept TOGETHER because they share the `isModelAdviceQuestion` local: advice-style
 * model questions short-circuit to `unknown` first, then build/train/create-model
 * and the conversational "follow-up model" block (which reads
 * `!isModelAdviceQuestion`) both resolve to `train_model`. This is the LAST
 * detector in the chain before the terminal `unknown` fallthrough.
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { IntentDetectorContext } from "./shared.js";

export function detectTrainModel(ctx: IntentDetectorContext): DataOpsIntent | null {
  const { lowerMessage } = ctx;

  // Detect advice-style questions about models (should NOT trigger train_model here)
  const isModelAdviceQuestion =
    (
      lowerMessage.includes('how can we improve') ||
      lowerMessage.includes('how do we improve') ||
      lowerMessage.includes('how to improve') ||
      lowerMessage.includes('what should we do') ||
      lowerMessage.includes('what can we do to') ||
      lowerMessage.includes('what would help') ||
      lowerMessage.includes('suggestions for') ||
      lowerMessage.includes('recommendations for') ||
      lowerMessage.includes('advice on')
    ) &&
    lowerMessage.includes('model');

  if (isModelAdviceQuestion) {
    return {
      operation: 'unknown',
      requiresClarification: false
    };
  }

  // ML Model training intent (regex fallback)
  if (lowerMessage.includes('build') && (lowerMessage.includes('model') || lowerMessage.includes('linear') || lowerMessage.includes('regression'))) {
    return {
      operation: 'train_model',
      requiresClarification: false
    };
  }

  if (lowerMessage.includes('train') && lowerMessage.includes('model')) {
    return {
      operation: 'train_model',
      requiresClarification: false
    };
  }

  if (lowerMessage.includes('create') && lowerMessage.includes('model')) {
    return {
      operation: 'train_model',
      requiresClarification: false
    };
  }

  // Follow-up / conversational model requests (regex fallback)
  if (
    lowerMessage.includes('model') &&
    !isModelAdviceQuestion && // Avoid treating pure advice questions as train_model
    (
      lowerMessage.includes('less variance') ||
      lowerMessage.includes('lowest variance') ||
      lowerMessage.includes('reduce variance') ||
      lowerMessage.includes('lower variance') ||
      lowerMessage.includes('different model') ||
      lowerMessage.includes('another model') ||
      lowerMessage.includes('better fit') ||
      lowerMessage.includes('improve fit') ||
      lowerMessage.includes('for above') ||
      lowerMessage.includes('the above') ||
      lowerMessage.includes('previous model') ||
      lowerMessage.includes('random forest') ||
      lowerMessage.includes('randomforest') ||
      lowerMessage.includes('decision tree') ||
      lowerMessage.includes('decisiontree')
    )
  ) {
    return {
      operation: 'train_model',
      requiresClarification: false
    };
  }

  return null;
}
