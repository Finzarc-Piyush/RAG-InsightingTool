import { z } from "zod";
import type { AgentWorkbenchEntry } from "../../../shared/schema.js";
import type { AgentConfig } from "./types.js";
import type { AgentExecutionContext } from "./types.js";
import { agentLog } from "./agentLogger.js";

export interface ToolRunContext {
  exec: AgentExecutionContext;
  config: AgentConfig;
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

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    name: string,
    input: z.ZodType<Record<string, unknown>>,
    run: ToolExecutor,
    meta: ToolManifestEntry
  ) {
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
