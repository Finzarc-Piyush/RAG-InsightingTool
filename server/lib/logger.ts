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
 */
type Level = "error" | "warn" | "info" | "debug";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

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

export const logger = {
  error: (...args: unknown[]): void => {
    if (enabled("error")) console.error(...args);
  },
  warn: (...args: unknown[]): void => {
    if (enabled("warn")) console.warn(...args);
  },
  info: (...args: unknown[]): void => {
    if (enabled("info")) console.info(...args);
  },
  /** Alias for info — matches the `console.log` call sites it replaces. */
  log: (...args: unknown[]): void => {
    if (enabled("info")) console.log(...args);
  },
  debug: (...args: unknown[]): void => {
    if (enabled("debug")) console.debug(...args);
  },
};
