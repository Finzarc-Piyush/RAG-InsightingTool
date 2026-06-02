/**
 * ============================================================================
 * promptBudget.ts — fit prompt sections into a fixed size, fairly and visibly
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Everything we send to an LLM has a size limit. The prompt is built from
 *   several blocks of text (the user's standing instructions, the schema, RAG
 *   search hits, the findings "blackboard", prior-investigation history, etc.).
 *   This file is a "budget allocator": you tell it the total character budget
 *   and which blocks are RESERVED (never cut — e.g. user directives) vs
 *   FLEXIBLE (can be trimmed). If the flexible blocks overflow, it shrinks them
 *   in a fixed priority order (RAG first since it's the most expendable, then
 *   blackboard, then history), trimming each proportionally. It works in
 *   characters, not tokens — characters are a coarse but stable proxy (roughly
 *   4 characters per English token).
 *
 * WHY IT MATTERS
 *   It replaces scattered ad-hoc `slice(0, N)` caps with ONE auditable place.
 *   The old way silently starved important context (a user could save 20 KB of
 *   notes but the narrator only ever saw 4 KB, with no signal). Now every cut
 *   is recorded so the caller can emit a `context_trimmed` SSE row, and
 *   user-supplied directives get a reserved slot that is NEVER trimmed — so the
 *   user's explicit instructions always survive.
 *
 * KEY PIECES
 *   - PromptBudget / DEFAULT_PROMPT_BUDGET — the budget shape and defaults.
 *   - flexibleBudget — chars left for flexible blocks after reservations.
 *   - applyFlexible — the core allocator: trims flexible blocks to fit,
 *       returns trimmed-block records for telemetry.
 *   - applyCap — drop-in replacement for one inline `value.slice(0, K)` that
 *       also records the trim.
 *   - formatContextTrimmedPayload — package trim records for an SSE row.
 *
 * HOW IT CONNECTS
 *   Pure logic, no I/O. Used by the agent's prompt builders. Callers forward
 *   the returned trim records into a `context_trimmed` SSE row (sibling to
 *   `flow_decision` per repo invariant #6).
 */

/** Map of well-known slot ids. Adding a new slot is a one-liner. */
export type ReservedSlot = "directives" | "instructions" | "schema";
export type FlexibleSlot = "rag" | "blackboard" | "history";

export interface PromptBudgetReserved {
  /** User directives — the `formatDirectiveBlock` output. Never trimmed. */
  directives: number;
  /** System instructions / role prompt header. Never trimmed. */
  instructions: number;
  /** Schema + categorical-values + hierarchy blocks. Never trimmed. */
  schema: number;
}

export interface PromptBudgetFlexible {
  /** RAG-hits / web-search bundle. */
  rag: number;
  /** Blackboard digest (domainContext + findings + open questions). */
  blackboard: number;
  /** History (priorInvestigations, verbatim notes, interpreted constraints). */
  history: number;
}

export interface PromptBudget {
  /** Total character budget for the prompt body. */
  total: number;
  /** Hard reservations, never trimmed. */
  reserved: PromptBudgetReserved;
  /** Trimmed in priority order if total exceeded. */
  flexible: PromptBudgetFlexible;
}

/** Default budget tuned for the agent runtime (≈ 32 K tokens of headroom).
 *  Tests + callers can override per call site. */
export const DEFAULT_PROMPT_BUDGET: PromptBudget = {
  total: 64_000,
  reserved: {
    directives: 16_000,
    instructions: 4_000,
    schema: 14_000,
  },
  flexible: {
    rag: 14_000,
    blackboard: 10_000,
    history: 6_000,
  },
};

/**
 * Compute the residual char budget for flexible slots after the reserved
 * slots are accounted for. Always returns ≥ 0 — when reserved overruns
 * the total, flexible budget collapses to 0 (extreme case; the caller's
 * own reserved slots already truncated user content if needed).
 */
export function flexibleBudget(budget: PromptBudget): number {
  const reservedTotal =
    budget.reserved.directives +
    budget.reserved.instructions +
    budget.reserved.schema;
  return Math.max(0, budget.total - reservedTotal);
}

/** Result row for a single flexible block after budget-driven trimming. */
export interface TrimmedBlockInfo {
  /** Stable id matching the request key (e.g. "rag", "blackboard:domain"). */
  id: string;
  /** Length in characters of the input pre-trim. */
  inputChars: number;
  /** Length of the output post-trim. */
  outputChars: number;
  /** Reason the block was trimmed (always `"budget"` today; reserved for
   *  future per-block governing reasons like `"limit"` or `"safety"`). */
  reason: "budget";
}

export interface ApplyFlexibleInput {
  /** Each block's id + content. Ordering does not matter — the allocator
   *  trims by `priorityOrder` (default: `["rag", "blackboard", "history"]`). */
  blocks: ReadonlyArray<{ id: string; slot: FlexibleSlot; content: string }>;
  budget: PromptBudget;
  /** Priority order from MOST-trimmable (first) to LEAST-trimmable (last). */
  priorityOrder?: ReadonlyArray<FlexibleSlot>;
  /** Optional per-block hard cap. Useful for caller-specific maxima
   *  (e.g. "the synthesizer permanent-notes block should never exceed
   *  12 K even when budget allows it"). Keyed by block id. */
  hardCaps?: Record<string, number>;
}

export interface ApplyFlexibleResult {
  /** Output content per block, in input order. */
  outputs: Array<{ id: string; slot: FlexibleSlot; content: string }>;
  /** Blocks that were trimmed (input-trimmed OR hard-capped). */
  trimmedBlocks: TrimmedBlockInfo[];
  /** Total flexible chars consumed after trim. */
  totalFlexibleChars: number;
  /** Residual flexible budget remaining. */
  remainingBudget: number;
}

/**
 * Apply the budget to a set of flexible blocks.
 *
 * Algorithm:
 *   1. Apply per-block hard caps first (caller-provided maxima).
 *   2. Sum the post-cap input. If it fits within the flexible budget,
 *      return all blocks unchanged.
 *   3. Otherwise, scale each slot's total down in `priorityOrder` (first
 *      = most trimmable) until the sum fits. Within a slot, trim each
 *      block proportionally to its share of the slot total.
 *   4. Mark every block whose output length is less than its input length
 *      as trimmed.
 */
export function applyFlexible(
  input: ApplyFlexibleInput
): ApplyFlexibleResult {
  const priorityOrder: ReadonlyArray<FlexibleSlot> =
    input.priorityOrder ?? ["rag", "blackboard", "history"];
  const hardCaps = input.hardCaps ?? {};

  const stage1 = input.blocks.map((b) => {
    const cap = hardCaps[b.id];
    const content =
      typeof cap === "number" && b.content.length > cap
        ? b.content.slice(0, cap)
        : b.content;
    return {
      id: b.id,
      slot: b.slot,
      content,
      origLength: b.content.length,
      hardCapped:
        typeof cap === "number" && b.content.length > cap,
    };
  });

  let usedChars = stage1.reduce((s, b) => s + b.content.length, 0);
  const remainingBudget = flexibleBudget(input.budget);

  // Stage 2 — fits as-is.
  if (usedChars <= remainingBudget) {
    return packResult(stage1, remainingBudget - usedChars);
  }

  // Stage 3 — over budget. Trim each slot in priorityOrder.
  let overshoot = usedChars - remainingBudget;
  for (const slot of priorityOrder) {
    if (overshoot <= 0) break;
    const inSlot = stage1.filter((b) => b.slot === slot);
    const slotTotal = inSlot.reduce((s, b) => s + b.content.length, 0);
    if (slotTotal === 0) continue;
    // Choose the smaller of: zero-out the slot entirely OR drop only what's
    // needed. Allocate the reduction across the slot's blocks proportionally
    // by current length so very-large blocks shrink most.
    const reduce = Math.min(slotTotal, overshoot);
    for (const b of inSlot) {
      if (b.content.length === 0) continue;
      const share = b.content.length / slotTotal;
      const target = Math.max(0, Math.floor(b.content.length - reduce * share));
      b.content = b.content.slice(0, target);
    }
    overshoot -= reduce;
  }

  usedChars = stage1.reduce((s, b) => s + b.content.length, 0);
  return packResult(stage1, Math.max(0, remainingBudget - usedChars));
}

function packResult(
  rows: ReadonlyArray<{
    id: string;
    slot: FlexibleSlot;
    content: string;
    origLength: number;
    hardCapped: boolean;
  }>,
  remainingBudget: number
): ApplyFlexibleResult {
  const outputs = rows.map((r) => ({
    id: r.id,
    slot: r.slot,
    content: r.content,
  }));
  const trimmed: TrimmedBlockInfo[] = rows
    .filter((r) => r.content.length < r.origLength)
    .map((r) => ({
      id: r.id,
      inputChars: r.origLength,
      outputChars: r.content.length,
      reason: "budget" as const,
    }));
  return {
    outputs,
    trimmedBlocks: trimmed,
    totalFlexibleChars: rows.reduce((s, r) => s + r.content.length, 0),
    remainingBudget,
  };
}

/**
 * Convenience helper for the common "single block trimmed by a hard cap"
 * pattern (replaces inline `value.slice(0, K)` calls). Returns the trimmed
 * value and an optional `TrimmedBlockInfo` when truncation occurred.
 *
 * This is the most-used API of the module — it's a drop-in replacement for
 * `value.slice(0, MAX_FOO_CAP)` that records a trim event the caller can
 * forward into a `context_trimmed` SSE row.
 */
export function applyCap(
  id: string,
  value: string | undefined | null,
  cap: number
): { content: string; trimmed?: TrimmedBlockInfo } {
  const s = (value ?? "").toString();
  if (s.length <= cap) return { content: s };
  return {
    content: s.slice(0, cap),
    trimmed: {
      id,
      inputChars: s.length,
      outputChars: cap,
      reason: "budget",
    },
  };
}

/** Coalesce multiple `TrimmedBlockInfo` rows into a single SSE payload
 *  shape. Returns `undefined` when no rows were trimmed. */
export function formatContextTrimmedPayload(
  rows: ReadonlyArray<TrimmedBlockInfo>
): { blocks: TrimmedBlockInfo[] } | undefined {
  if (!rows.length) return undefined;
  return { blocks: rows.slice() };
}
