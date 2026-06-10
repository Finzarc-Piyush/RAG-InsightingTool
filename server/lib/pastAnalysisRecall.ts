/**
 * Part 3.2 · Full-fidelity recall of a prior turn's analytical result.
 *
 * Every analytical breakdown the agent runs is persisted in its entirety to the
 * `past_analyses` container as a `PastAnalysisPivotArtifact` (inline rows, or a
 * blob ref when large — see pastAnalysisPivotArtifact.ts). This module reads
 * those back so a FOLLOW-UP question can build on a prior result instead of
 * re-deriving it: given a free-text description, it semantic-lite matches the
 * session's stored results (by question text + pivot label + column headers)
 * and returns the best match's FULL rows.
 *
 * Storage is server-side and keyed by chat/turn/step — nothing analytical lives
 * in browser memory. The agent reaches this via the `retrieve_prior_result`
 * tool; the HTTP recall endpoint (pastAnalysisRecallController) reuses
 * `loadPriorArtifactRows` for the same inline/blob fetch.
 */
import { getFileFromBlob } from "./blobStorage.js";
import { listPastAnalysesForSession } from "../models/pastAnalysis.model.js";
import type {
  PastAnalysisDoc,
  PastAnalysisPivotArtifact,
} from "../shared/schema.js";

/** Load an artifact's full rows — inline rows verbatim, else download+parse the blob. */
export async function loadPriorArtifactRows(
  artifact: PastAnalysisPivotArtifact
): Promise<Record<string, unknown>[]> {
  if (artifact.storage.kind === "inline") {
    return artifact.storage.rows ?? [];
  }
  const buf = await getFileFromBlob(artifact.storage.blobName);
  return JSON.parse(buf.toString("utf8")) as Record<string, unknown>[];
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "by", "for", "to", "in", "on", "and", "or", "is",
  "are", "what", "which", "how", "show", "me", "give", "that", "this", "from",
  "earlier", "prior", "previous", "last", "above", "those", "them", "it",
]);

function tokenize(s: string | undefined): string[] {
  return (s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface PriorResultMatch {
  /** The question the prior turn answered. */
  question: string;
  /** The prior turn's written answer (markdown). */
  answer: string;
  createdAt: number;
  artifactId: string;
  columns: string[];
  rowCount: number;
  /** The full stored rows (inline or fetched from blob). */
  rows: Record<string, unknown>[];
  /** Token-overlap score against the recall query (higher = better match). */
  score: number;
}

export interface FindPriorResultOptions {
  lister?: (sessionId: string, limit?: number) => Promise<PastAnalysisDoc[]>;
  rowLoader?: (artifact: PastAnalysisPivotArtifact) => Promise<Record<string, unknown>[]>;
  maxDocs?: number;
}

/**
 * Find the stored prior-turn result that best matches `query`. Scores every
 * artifact across the session's recent analyses by token overlap of the query
 * against (question · pivot label · column headers), then loads the winner's
 * full rows. Returns null when nothing meaningfully matches.
 */
export async function findRelevantPriorResult(
  sessionId: string,
  query: string,
  opts: FindPriorResultOptions = {}
): Promise<PriorResultMatch | null> {
  const lister = opts.lister ?? listPastAnalysesForSession;
  const rowLoader = opts.rowLoader ?? loadPriorArtifactRows;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return null;

  const docs = await lister(sessionId, opts.maxDocs ?? 50);
  let best: { doc: PastAnalysisDoc; artifact: PastAnalysisPivotArtifact; score: number } | null = null;
  for (const doc of docs) {
    for (const artifact of doc.pivotArtifacts ?? []) {
      const hay = new Set(
        tokenize(
          `${doc.question} ${artifact.questionContext ?? ""} ${(artifact.columnHeaders ?? []).join(" ")}`
        )
      );
      let score = 0;
      for (const t of qTokens) if (hay.has(t)) score += 1;
      if (score > (best?.score ?? 0)) best = { doc, artifact, score };
    }
  }
  if (!best || best.score === 0) return null;

  const rows = await rowLoader(best.artifact);
  return {
    question: best.doc.question,
    answer: best.doc.answer,
    createdAt: best.doc.createdAt,
    artifactId: best.artifact.artifactId,
    columns: best.artifact.columnHeaders ?? [],
    rowCount: best.artifact.rowCount,
    rows,
    score: best.score,
  };
}
