/**
 * ============================================================================
 * models.ts — picks WHICH AI model to use for each kind of task.
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Different jobs need different AI models. Quick classification jobs (working
 *   out a question's intent or mode) can use a small, cheap, fast model; writing
 *   the final answer wants a bigger, smarter one; turning text into vectors for
 *   search ("embeddings") uses a dedicated embedding model. This tiny file holds
 *   that mapping. The actual model names come from environment variables (so they
 *   can be swapped per deployment) with sensible Azure OpenAI defaults baked in.
 *
 * WHY IT MATTERS
 *   Centralising the choice keeps cost and latency under control — the
 *   classifiers in this folder (intentClassifier, modeClassifier) all ask for
 *   the cheap "intent" tier here rather than burning
 *   the expensive generation model on simple labelling. One place to retune.
 *
 * KEY PIECES
 *   - MODELS — the lookup table: intent (cheap classifier), generation (powerful
 *     writer), embeddings (vector model). Values resolved from env vars.
 *   - getModelForTask(task) — returns the model name for 'intent' |
 *     'generation' | 'embeddings'.
 *   - shouldUseFastModel() — true when the intent and generation models actually
 *     differ (i.e. a real cheap tier is configured).
 *
 * HOW IT CONNECTS
 *   getModelForTask('intent') is called by intentClassifier.ts and
 *   modeClassifier.ts before each LLM call. No I/O of
 *   its own — just reads process.env and returns strings.
 */

export const MODELS = {
  // Intent classification - faster and cheaper
  intent: process.env.AZURE_OPENAI_INTENT_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o-mini',
  
  // Text generation - more powerful
  generation: process.env.AZURE_OPENAI_DEPLOYMENT_NAME || 'gpt-4o',
  
  // Embeddings - Azure OpenAI compatible models
  embeddings: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME || 'text-embedding-3-small',
} as const;

export type ModelType = keyof typeof MODELS;

/**
 * Get the appropriate model for a given task
 */
export function getModelForTask(task: 'intent' | 'generation' | 'embeddings'): string {
  return MODELS[task];
}

/**
 * Check if we should use a faster model for classification
 */
export function shouldUseFastModel(): boolean {
  return MODELS.intent !== MODELS.generation;
}

