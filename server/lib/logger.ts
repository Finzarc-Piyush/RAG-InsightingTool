/**
 * Wave R28 · General level-based server logger.
 *
 * A drop-in for `console.*` (same call shape) that adds production log control:
 * level gating via the `LOG_LEVEL` env var. Distinct from `agentLogger.agentLog`
 * (event-based agent telemetry) — this is for ordinary diagnostic logging across
 * controllers / lib / services.
 *
 * Levels (most → least severe): error, warn, info, debug. `logger.log` is an
 * alias for info. `LOG_LEVEL` (error|warn|info|debug) sets the threshold;
 * messages at or above it emit. DEFAULT is `debug` — i.e. everything emits,
 * IDENTICAL to the raw `console.*` it replaces, so the console→logger sweep is
 * behaviour-preserving out of the box. Operators set `LOG_LEVEL=info` (or warn)
 * in production to cut noise without a code change.
 *
 * EX4 / OBS-1 · Structured output. When `LOG_FORMAT=json` (or in production /
 * on Vercel) every line is emitted as a single JSON object carrying the request
 * correlation fields (traceId, sessionId, userId, turnId) pulled from the
 * AsyncLocalStorage-backed request context. This makes an on-call engineer able
 * to tie any log line back to the turn that produced it — across all ~970 call
 * sites, with no call-site edits. In dev (default) it stays a plain console
 * passthrough so local logs remain human-readable.
 */
import { getRequestContext } from "./telemetry/requestContext.js";

type Level = "error" | "warn" | "info" | "debug" | "log";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, log: 2, debug: 3 };

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL || "").trim().toLowerCase();
  if (raw && raw in RANK) return RANK[raw as Level];
  return RANK.debug; // default: emit everything (behaviour-preserving)
}

// Resolved once at module load; LOG_LEVEL is a deploy-time setting.
const threshold = resolveThreshold();

function enabled(level: Level): boolean {
  return RANK[level] <= threshold;
}

/**
 * Structured (JSON) output is on when `LOG_FORMAT=json`, or implicitly in
 * production / on Vercel. `LOG_FORMAT=text` is an explicit opt-out (e.g. to keep
 * a prod shell readable). Resolved once — it's a deploy-time setting.
 */
function resolveStructured(): boolean {
  const fmt = (process.env.LOG_FORMAT || "").trim().toLowerCase();
  if (fmt === "json") return true;
  if (fmt === "text") return false;
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}
const structured = resolveStructured();

// Map the logical level to the console method that preserves the stdout/stderr
// split (error/warn → stderr) operators rely on.
const CONSOLE_METHOD: Record<Level, "error" | "warn" | "info" | "debug" | "log"> = {
  error: "error",
  warn: "warn",
  info: "info",
  log: "log",
  debug: "debug",
};

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function emit(level: Level, args: unknown[]): void {
  if (!enabled(level)) return;
  const method = CONSOLE_METHOD[level];
  if (!structured) {
    // Behaviour-preserving console passthrough (dev default).
    (console[method] as (...a: unknown[]) => void)(...args);
    return;
  }
  const ctx = getRequestContext();
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level: level === "log" ? "info" : level,
    msg: args.map(fmtArg).join(" "),
  };
  if (ctx.traceId) line.traceId = ctx.traceId;
  if (ctx.sessionId) line.sessionId = ctx.sessionId;
  if (ctx.userId) line.userId = ctx.userId;
  if (ctx.turnId) line.turnId = ctx.turnId;
  (console[method] as (...a: unknown[]) => void)(JSON.stringify(line));
}

export const logger = {
  error: (...args: unknown[]): void => emit("error", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  info: (...args: unknown[]): void => emit("info", args),
  /** Alias for info — matches the `console.log` call sites it replaces. */
  log: (...args: unknown[]): void => emit("log", args),
  debug: (...args: unknown[]): void => emit("debug", args),
};
