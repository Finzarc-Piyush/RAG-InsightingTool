import { openai } from "../openai.js";
import { getEmbeddingDimensions } from "./config.js";

const BATCH = 16;

/**
 * Embed texts using Azure OpenAI embedding deployment (existing client).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const dim = getEmbeddingDimensions();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await openai.embeddings.create({
      model: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME || "text-embedding-3-small",
      input: batch,
    });
    for (const d of res.data.sort((a, b) => a.index - b.index)) {
      const v = d.embedding as number[];
      if (v.length !== dim) {
        console.warn(
          `⚠️ RAG: embedding dim ${v.length} != expected ${dim}; set AZURE_OPENAI_EMBEDDING_DIMENSIONS`
        );
      }
      out.push(v);
    }
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const v = await embedTexts([text]);
  return v[0] || [];
}
