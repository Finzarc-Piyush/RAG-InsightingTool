/**
 * ============================================================================
 * toolRegistry.ts — the catalogue and runner for the agent's tools
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The agent answers questions by calling "tools" — structured actions like
 *   running a DuckDB SQL query, computing a correlation, doing segment-driver
 *   analysis, or a web search. This file defines the registry that holds every
 *   tool: each tool is registered once with a name, a Zod input schema (which
 *   validates the arguments the planner LLM supplies), the function that runs it,
 *   and a one-line description + args hint shown to the planner. It also runs
 *   tools safely: validate args, execute, time it, log, and turn any thrown error
 *   into a normal `{ ok: false, summary }` result instead of crashing the turn.
 *
 * WHY IT MATTERS
 *   This is the single doorway between the agent's reasoning and the real actions
 *   it can take. The shared ToolResult shape (summary, charts, insights, parsed
 *   query, analytical metadata, etc.) is how every tool reports back to the loop,
 *   reflector, and narrator. Duplicate tool names are a fatal mistake (a merge
 *   landed two implementations), so registration throws rather than silently
 *   replacing one — failing loud at boot beats swapping behaviour at runtime.
 *
 * KEY PIECES
 *   - ToolRegistry — the map of name → tool; register / execute / validate /
 *     format-manifest-for-planner / list-descriptions.
 *   - ToolResult / ToolExecutor / ToolRunContext — the contracts every tool
 *     implements and receives.
 *   - ToolManifestEntry — the planner-facing {description, argsHelp} metadata.
 *   - ToolAlreadyRegisteredError — thrown on a duplicate name at boot.
 *
 * HOW IT CONNECTS
 *   Tools are added in tools/<name>Tool.ts and wired up in registerTools.ts.
 *   Uses AgentConfig / AgentExecutionContext (types.js) and agentLog
 *   (agentLogger.js). The act loop calls execute(); the planner reads
 *   formatToolManifestForPlanner() to know what tools exist and how to call them.
 */
import { z } from "zod";
import type { AgentWorkbenchEntry } from "../../../shared/schema.js";
import type { AgentConfig } from "./types.js";
import type { AgentExecutionContext } from "./types.js";
import { agentLog } from "./agentLogger.js";

export interface ToolRunContext {
  exec: AgentExecutionContext;
  config: AgentConfig;
  /** Optional — current turn id for tools that emit Memory entries. */
  turnId?: string;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  charts?: import("../../../shared/schema.js").ChartSpec[];
  insights?: import("../../../shared/schema.js").Insight[];
  /** For deterministic numeric verify */
  numericPayload?: string;
  table?: any;
  operationResult?: any;
  clarify?: string;
  /** Full assistant text when a delegate tool ran the legacy orchestrator */
  answerFragment?: string;
  /** Column names suggested from retrieve_semantic_context (for planner chaining) */
  suggestedColumns?: string[];
  /** Short structured facts for working-memory / chained planning */
  memorySlots?: Record<string, string>;
  /** From retrieve_semantic_context — for observability */
  ragHitCount?: number;
  /** From run_analytical_query — for reflector / replan (no keyword parsing) */
  analyticalMeta?: {
    inputRowCount: number;
    outputRowCount: number;
    appliedAggregation: boolean;
  };
  /** Structured query after execute_query_plan (observation lints) */
  queryPlanParsed?: import("../../../shared/queryTypes.js").ParsedQuery | null;
  /** Shown in chat workbench (e.g. parsed analytical query JSON). */
  workbenchArtifact?: AgentWorkbenchEntry;
}

export type ToolExecutor = (
  ctx: ToolRunContext,
  args: Record<string, unknown>
) => Promise<ToolResult>;

export interface ToolManifestEntry {
  /** One-line purpose for the planner */
  description: string;
  /** JSON-shaped hint: allowed keys only (strict schemas reject unknown keys) */
  argsHelp: string;
}

type RegisteredTool = {
  input: z.ZodType<Record<string, unknown>>;
  run: ToolExecutor;
  description: string;
  argsHelp: string;
};

/**
 * Thrown when `ToolRegistry.register` is called with a name that is
 * already registered. The registry is meant to be populated once at boot
 * (via `registerTools`), so a duplicate indicates a merge conflict or a
 * double-import — either way the run should fail loud, not swap
 * implementations at runtime.
 */
export class ToolAlreadyRegisteredError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Tool "${toolName}" is already registered. Tools are registered once at boot; ` +
        `a duplicate usually means a merge landed two implementations. Remove one or rename it.`
    );
    this.name = "ToolAlreadyRegisteredError";
    this.toolName = toolName;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    name: string,
    input: z.ZodType<Record<string, unknown>>,
    run: ToolExecutor,
    meta: ToolManifestEntry
  ) {
    if (this.tools.has(name)) {
      throw new ToolAlreadyRegisteredError(name);
    }
    this.tools.set(name, { input, run, description: meta.description, argsHelp: meta.argsHelp });
  }

  listToolDescriptions(): string {
    return Array.from(this.tools.keys()).join(", ");
  }

  /** Comma-separated names only (legacy / compact logs). */
  formatToolManifestForPlanner(maxChars = 14_000): string {
    const blocks: string[] = [];
    for (const [name, t] of this.tools) {
      blocks.push(
        `- ${name}: ${t.description}\n  args (strict; do not add other keys): ${t.argsHelp}`
      );
    }
    const full = blocks.join("\n\n");
    if (full.length <= maxChars) return full;
    return `${full.slice(0, maxChars)}\n\n...(manifest truncated)`;
  }

  argsValidForTool(name: string, rawArgs: Record<string, unknown>): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    return t.input.safeParse(rawArgs).success;
  }

  /** Truncated Zod message for logging (no raw arg values). */
  getArgsParseError(name: string, rawArgs: Record<string, unknown>): string | undefined {
    const t = this.tools.get(name);
    if (!t) return undefined;
    const r = t.input.safeParse(rawArgs);
    if (r.success) return undefined;
    const msg = r.error.message;
    return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
  }

  getArgsHelpForTool(name: string): string | undefined {
    return this.tools.get(name)?.argsHelp;
  }

  async execute(
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: ToolRunContext
  ): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) {
      return { ok: false, summary: `Unknown tool: ${name}` };
    }
    const parsed = t.input.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        ok: false,
        summary: `Invalid args for ${name}: ${parsed.error.message}`,
      };
    }
    const started = Date.now();
    try {
      const out = await t.run(ctx, parsed.data);
      agentLog("tool_done", {
        tool: name,
        ms: Date.now() - started,
        ok: out.ok,
      });
      return out;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      agentLog("tool_error", { tool: name, ms: Date.now() - started });
      return { ok: false, summary: msg };
    }
  }
}
