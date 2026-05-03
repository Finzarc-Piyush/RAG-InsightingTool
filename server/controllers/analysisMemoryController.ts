/**
 * W61 · HTTP endpoints for the per-session Analysis Memory journal.
 *
 *   GET  /api/sessions/:sessionId/memory                — paginated list
 *   GET  /api/sessions/:sessionId/memory/search         — semantic search
 *   GET  /api/sessions/:sessionId/memory/export         — markdown / JSON export
 *
 * Auth: existing `requireAzureAdAuth` middleware applies via `/api`. Each
 * endpoint additionally checks `getChatBySessionIdForUser` so a user can only
 * read memory for sessions they own (or have collaborator access to).
 */
import { Request, Response } from "express";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { getChatBySessionIdForUser } from "../models/chat.model.js";
import {
  listMemoryEntries,
  type ListMemoryOptions,
} from "../models/analysisMemory.model.js";
import {
  analysisMemoryEntryTypeSchema,
  type AnalysisMemoryEntry,
  type AnalysisMemoryEntryType,
} from "../shared/schema.js";
import { searchMemoryEntries } from "../lib/rag/retrieve.js";

function parseTypes(raw: unknown): AnalysisMemoryEntryType[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const parsed: AnalysisMemoryEntryType[] = [];
  for (const t of tokens) {
    const r = analysisMemoryEntryTypeSchema.safeParse(t);
    if (r.success) parsed.push(r.data);
  }
  return parsed.length === 0 ? undefined : parsed;
}

function parseNum(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function authorizeSession(req: Request, res: Response): Promise<{
  sessionId: string;
  username: string;
} | null> {
  const username = requireUsername(req);
  const sessionId = req.params.sessionId;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId required" });
    return null;
  }
  const session = await getChatBySessionIdForUser(sessionId, username);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  return { sessionId, username };
}

export const getMemoryEntriesEndpoint = async (
  req: Request,
  res: Response
) => {
  try {
    const auth = await authorizeSession(req, res);
    if (!auth) return;

    const opts: ListMemoryOptions = {
      types: parseTypes(req.query.type ?? req.query.types),
      since: parseNum(req.query.since),
      cursorCreatedAt: parseNum(req.query.cursor),
      limit: parseNum(req.query.limit),
    };
    const entries = await listMemoryEntries(auth.sessionId, opts);
    const nextCursor =
      entries.length > 0 ? entries[entries.length - 1]!.createdAt : null;
    return res.json({
      entries,
      count: entries.length,
      nextCursor,
    });
  } catch (err: any) {
    if (err instanceof AuthenticationError) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    console.error("getMemoryEntriesEndpoint error:", err);
    return res.status(500).json({ error: "Failed to load memory entries" });
  }
};

export const searchMemoryEndpoint = async (req: Request, res: Response) => {
  try {
    const auth = await authorizeSession(req, res);
    if (!auth) return;

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      return res.json({ hits: [], query: "" });
    }
    const topK = Math.min(parseNum(req.query.k) ?? 12, 50);

    const result = await searchMemoryEntries({
      sessionId: auth.sessionId,
      query: q,
      topK,
    });
    return res.json({
      hits: result.hits,
      query: q,
      ...(result.retrievalError ? { retrievalError: result.retrievalError } : {}),
      ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    });
  } catch (err: any) {
    if (err instanceof AuthenticationError) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    console.error("searchMemoryEndpoint error:", err);
    return res.status(500).json({ error: "Memory search failed" });
  }
};

function entriesToMarkdown(
  entries: AnalysisMemoryEntry[],
  sessionId: string
): string {
  const lines: string[] = [];
  lines.push(`# Analysis Memory · session ${sessionId}`);
  lines.push(`Generated ${new Date().toISOString()} · ${entries.length} entries`);
  lines.push("");
  // Group by turnId so the timeline reads naturally; lifecycle entries (no
  // turnId) come first.
  const byTurn = new Map<string, AnalysisMemoryEntry[]>();
  for (const e of entries) {
    const key = e.turnId ?? "__lifecycle__";
    const arr = byTurn.get(key) ?? [];
    arr.push(e);
    byTurn.set(key, arr);
  }
  const lifecycle = byTurn.get("__lifecycle__") ?? [];
  byTurn.delete("__lifecycle__");
  if (lifecycle.length > 0) {
    lines.push("## Lifecycle");
    for (const e of lifecycle) {
      lines.push(`- **[${e.type}]** ${e.title} — ${e.summary}`);
    }
    lines.push("");
  }
  for (const [turnId, group] of byTurn) {
    const at = new Date(group[0]!.createdAt).toISOString();
    const question =
      group.find((e) => e.type === "question_asked")?.title ?? "(no question)";
    lines.push(`## Turn ${turnId} · ${at}`);
    lines.push(`> ${question}`);
    lines.push("");
    for (const e of group) {
      if (e.type === "question_asked") continue;
      lines.push(`- **[${e.type}]** ${e.title} — ${e.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export const exportMemoryEndpoint = async (req: Request, res: Response) => {
  try {
    const auth = await authorizeSession(req, res);
    if (!auth) return;

    const format = (
      typeof req.query.format === "string" ? req.query.format : "markdown"
    ).toLowerCase();
    // Pull a generous page; 5000 is well above the realistic cap for a single
    // session even after many turns.
    const entries = await listMemoryEntries(auth.sessionId, { limit: 500 });

    if (format === "json") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="analysis-memory-${auth.sessionId}.json"`
      );
      return res.json({ sessionId: auth.sessionId, entries });
    }
    const md = entriesToMarkdown(entries, auth.sessionId);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="analysis-memory-${auth.sessionId}.md"`
    );
    return res.send(md);
  } catch (err: any) {
    if (err instanceof AuthenticationError) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    console.error("exportMemoryEndpoint error:", err);
    return res.status(500).json({ error: "Memory export failed" });
  }
};
