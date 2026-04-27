/**
 * Wave W7 · buildSynthesisContext
 *
 * Pure-ish helper that bundles the contextual signals the project already
 * computes (domain packs, RAG hits, data understanding, user identity) into
 * four labelled markdown blocks. The narrator and synthesizer both consume
 * the same bundle so prompt-cache prefixes stay byte-stable across calls
 * within a turn.
 *
 * Why this lives outside the writers: pre-W7, the narrator and synthesizer
 * each had to mine signals out of the raw `sessionAnalysisContext` JSON blob
 * and never saw the domain packs or upfront RAG hits at all. Centralising
 * the bundle here means new context (e.g. web-search hits in a later wave)
 * gets wired into both writers in one place.
 */
import type { AgentExecutionContext } from "./types.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";

const DOMAIN_BLOCK_CHAR_CAP = 6_000;
// W16 · 4_000 → 6_000 to make room for the third sub-section (web search
// hits) alongside upfront RAG (round 1) and findings-driven RAG (round 2).
// Each web hit is ~1.5k chars × up to 5 hits = 7.5k worst case, but the tool
// already caps at 6k formatted, and synth-prompt-budget headroom is fine.
const RAG_BLOCK_CHAR_CAP = 6_000;
const COLUMN_ROLES_MAX = 20;
const SUGGESTED_FOLLOWUPS_MAX = 4;
const PERMANENT_NOTES_CAP = 2_000;

export interface SynthesisContextBundle {
  /** FMCG/Marico authored packs (already loaded into ctx.domainContext). */
  domainBlock: string;
  /** Pre-extracted dataset summary: grain, top column roles, caveats, applied filters. */
  dataUnderstandingBlock: string;
  /** Upfront RAG hits + blackboard.domainContext entries (rag_round1 / rag_round2). */
  ragBlock: string;
  /** Authenticated user identity, permanent notes, suggested follow-ups. */
  userBlock: string;
}

export interface BuildSynthesisContextInput {
  /** Optional formatted RAG block from the upfront retrieval (P-A1). */
  upfrontRagHitsBlock?: string;
  /** Optional analytical blackboard — `domainContext` entries surface here as RAG round-2 hits. */
  blackboard?: AnalyticalBlackboard;
}

/**
 * Compose the four bundle blocks. Each block is independently optional and
 * returns "" when no signal is present, so the caller can join with section
 * headers and let empty sections vanish.
 */
export function buildSynthesisContext(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput = {}
): SynthesisContextBundle {
  return {
    domainBlock: buildDomainBlock(ctx),
    dataUnderstandingBlock: buildDataUnderstandingBlock(ctx),
    ragBlock: buildRagBlock(ctx, input),
    userBlock: buildUserBlock(ctx),
  };
}

function buildDomainBlock(ctx: AgentExecutionContext): string {
  const raw = ctx.domainContext?.trim();
  if (!raw) return "";
  return raw.slice(0, DOMAIN_BLOCK_CHAR_CAP);
}

function buildDataUnderstandingBlock(ctx: AgentExecutionContext): string {
  const sac = ctx.sessionAnalysisContext;
  const lines: string[] = [];

  if (sac?.dataset?.shortDescription) {
    lines.push(`Dataset: ${sac.dataset.shortDescription.trim()}`);
  }

  const summary = ctx.summary;
  if (summary && (summary.rowCount || summary.columnCount)) {
    const r = typeof summary.rowCount === "number" ? summary.rowCount : "?";
    const c = typeof summary.columnCount === "number" ? summary.columnCount : "?";
    lines.push(`Shape: ${r} rows × ${c} columns`);
  }

  const grain = sac?.dataset?.grainGuess?.trim();
  if (grain) lines.push(`Grain: ${grain}`);

  const roles = sac?.dataset?.columnRoles ?? [];
  if (roles.length > 0) {
    const sliced = roles.slice(0, COLUMN_ROLES_MAX);
    lines.push("Key columns:");
    for (const r of sliced) {
      const note = r.notes?.trim() ? ` — ${r.notes.trim().slice(0, 200)}` : "";
      lines.push(`  • ${r.name} (${r.role})${note}`);
    }
    if (roles.length > COLUMN_ROLES_MAX) {
      lines.push(`  …and ${roles.length - COLUMN_ROLES_MAX} more.`);
    }
  }

  const caveats = (sac?.dataset?.caveats ?? []).filter(Boolean);
  if (caveats.length > 0) {
    lines.push("Data caveats:");
    for (const c of caveats.slice(0, 6)) lines.push(`  • ${c}`);
  }

  const filters = ctx.inferredFilters ?? [];
  if (filters.length > 0) {
    const formatted = filters
      .slice(0, 8)
      .map((f) => `${f.column} ${f.op} [${f.values.slice(0, 6).join(", ")}]`);
    lines.push(`Applied filters this turn: ${formatted.join("; ")}`);
  }

  const facts = (sac?.sessionKnowledge?.facts ?? []).filter(
    (f) => f.confidence !== "low"
  );
  if (facts.length > 0) {
    lines.push("Established facts (from prior turns):");
    for (const f of facts.slice(0, 6)) {
      lines.push(`  • [${f.confidence}] ${f.statement}`);
    }
  }

  return lines.join("\n").trim();
}

function buildRagBlock(
  ctx: AgentExecutionContext,
  input: BuildSynthesisContextInput
): string {
  const parts: string[] = [];

  const upfront = input.upfrontRagHitsBlock?.trim();
  if (upfront) {
    parts.push(`# Upfront retrieval (round 1)\n${upfront}`);
  }

  const round2 =
    input.blackboard?.domainContext?.filter(
      (e) => e.source === "rag_round2"
    ) ?? [];
  if (round2.length > 0) {
    const r2Block = round2
      .map((e) => `[${e.source}:${e.id}] ${e.content.trim()}`)
      .join("\n---\n");
    parts.push(`# Findings-driven retrieval (round 2)\n${r2Block}`);
  }

  // W16 · web search hits live in the same blackboard slot under
  // `source: "web"`. They render in their own sub-section so the synthesizer
  // sees them as background grounding, never as numeric evidence. The tool
  // already formats hits with `[web:tavily:N]` prefixes, so we don't double-
  // tag them with the dc-id — just emit the content verbatim.
  const webHits =
    input.blackboard?.domainContext?.filter((e) => e.source === "web") ?? [];
  if (webHits.length > 0) {
    const webBlock = webHits.map((e) => e.content.trim()).join("\n---\n");
    parts.push(`# Web search context\n${webBlock}`);
  }

  void ctx; // reserved for future synthesis-time RAG re-call
  const joined = parts.join("\n\n").trim();
  return joined.slice(0, RAG_BLOCK_CHAR_CAP);
}

function buildUserBlock(ctx: AgentExecutionContext): string {
  const lines: string[] = [];

  if (ctx.username?.trim()) {
    lines.push(`Authenticated user: ${ctx.username.trim()}`);
  }

  if (ctx.permanentContext?.trim().length) {
    lines.push(
      `User notes (verbatim):\n${ctx.permanentContext.trim().slice(0, PERMANENT_NOTES_CAP)}`
    );
  }

  const followUps =
    ctx.sessionAnalysisContext?.suggestedFollowUps?.filter(Boolean) ?? [];
  if (followUps.length > 0) {
    lines.push("Suggested follow-ups carried from prior turns:");
    for (const f of followUps.slice(0, SUGGESTED_FOLLOWUPS_MAX)) {
      lines.push(`  • ${f}`);
    }
  }

  return lines.join("\n").trim();
}

/**
 * Format the bundle as a single labelled markdown string for inclusion in
 * the synthesis user prompt. Empty blocks are omitted so the prompt stays
 * minimal when signals are missing.
 */
export function formatSynthesisContextBundle(
  bundle: SynthesisContextBundle
): string {
  const sections: string[] = [];

  if (bundle.dataUnderstandingBlock) {
    sections.push(`## DATA UNDERSTANDING\n${bundle.dataUnderstandingBlock}`);
  }
  if (bundle.userBlock) {
    sections.push(`## USER CONTEXT\n${bundle.userBlock}`);
  }
  if (bundle.ragBlock) {
    sections.push(
      // W16 · clarify that web hits (when present) follow the same rule as
      // RAG hits — background grounding, never numeric evidence. Citations
      // can use the [web:tavily:N] tags the tool emitted.
      `## RELATED CONTEXT (RAG / web)\nUse for grounding and citation only — never as numeric evidence. RAG and web tags (\`[web:tavily:N]\`) may be cited inline when the framing is material.\n${bundle.ragBlock}`
    );
  }
  if (bundle.domainBlock) {
    sections.push(
      `## DOMAIN KNOWLEDGE (FMCG / Marico)\nAuthored background. Cite the pack id (e.g. \`marico-haircare-portfolio\`) when you reference it. Treat as orientation only — never as numeric evidence; tool output is authoritative for figures.\n${bundle.domainBlock}`
    );
  }

  return sections.join("\n\n").trim();
}
