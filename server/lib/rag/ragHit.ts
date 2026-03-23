/** One row returned from session-scoped vector search. */
export interface RagHit {
  chunkId: string;
  chunkType: string;
  content: string;
  score?: number;
}
