/**
 * WD6 · Memoized loader for the enabled domain context block.
 *
 * Composes enabled packs (sorted by priority) into a single string with stable
 * `<<DOMAIN PACK: id>> ... <</DOMAIN PACK>>` markers. Memoised at process scope
 * so the same string is reused across LLM calls and the user-message prefix
 * stays cache-friendly.
 *
 * `invalidateDomainContextCache()` is called from the admin PATCH handler when
 * a toggle changes — the next call rebuilds.
 */

import { PACKS } from "./generatedPacks.js";
import { getToggleOverrides } from "../../models/domainContextToggles.model.js";
import type { DomainPack, PackSummary } from "./types.js";
import { logger } from "../logger.js";

const TOKEN_BUDGET_WARN = 12_000;

interface CacheEntry {
  text: string;
  packs: PackSummary[];
  totalEnabledTokens: number;
}

/**
 * Wave A7 · Generation counter + cache atomicity.
 *
 * Pre-A7 the cache was a single `Promise<CacheEntry> | null`. The race
 * window:
 *   1. LLM call A awaits `loadEnabledDomainContext()` — cache null,
 *      `build()` starts, cache := the new promise.
 *   2. A yields waiting on `getToggleOverrides()` network call.
 *   3. Admin PATCH toggle calls `invalidateDomainContextCache()` —
 *      cache := null.
 *   4. LLM call B starts — cache null, builds a FRESH promise with new
 *      toggles, awaits it, sees NEW context.
 *   5. LLM call A's promise resolves with OLD context (the one built at
 *      step 2 with pre-toggle data).
 *
 * Net: two LLM calls in the same turn (or close-spaced turns) see
 * DIFFERENT domain context across an admin toggle. The "old promise"
 * served stale data after the cache was invalidated.
 *
 * Fix: tag every in-flight build with the generation counter at spawn.
 * `invalidate*Cache()` bumps the counter. When a build resolves, check
 * the counter — if it's bumped, discard the result and rebuild. Callers
 * see the freshest data possible.
 *
 * Single-instance correctness only (matches the rest of the codebase).
 * Multi-instance scaling needs a Cosmos-backed version watcher.
 */
let cache: Promise<CacheEntry> | null = null;
let cacheGeneration = 0;

function isEnabled(
  pack: DomainPack,
  overrides: Record<string, boolean>
): boolean {
  if (Object.prototype.hasOwnProperty.call(overrides, pack.id)) {
    return overrides[pack.id];
  }
  return pack.enabledByDefault;
}

/**
 * Pure composition — exported for tests. Given a pack list and an overrides
 * map, returns the composed text + per-pack summaries. No I/O.
 */
export function composeDomainContext(
  packs: ReadonlyArray<DomainPack>,
  overrides: Record<string, boolean>
): CacheEntry {
  const summaries: PackSummary[] = PACKS.map((p) => ({
    id: p.id,
    title: p.title,
    category: p.category,
    priority: p.priority,
    version: p.version,
    approxTokens: p.approxTokens,
    enabled: isEnabled(p, overrides),
    defaultEnabled: p.enabledByDefault,
  })).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const enabledPacks = packs
    .filter((p) => isEnabled(p, overrides))
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const totalEnabledTokens = enabledPacks.reduce((s, p) => s + p.approxTokens, 0);

  if (!enabledPacks.length) {
    return { text: "", packs: summaries, totalEnabledTokens: 0 };
  }

  const blocks = enabledPacks.map((p) => {
    return `<<DOMAIN PACK: ${p.id}>>\n# ${p.title}\n${p.body.trim()}\n<</DOMAIN PACK>>`;
  });

  if (totalEnabledTokens > TOKEN_BUDGET_WARN) {
    logger.warn(
      `domainContext: enabled packs ~${totalEnabledTokens} tokens — exceeds ` +
        `${TOKEN_BUDGET_WARN} warn threshold (${enabledPacks.length} packs). ` +
        `Consider disabling lower-priority packs from the admin UI.`
    );
  }
  return { text: blocks.join("\n\n"), packs: summaries, totalEnabledTokens };
}

async function build(): Promise<CacheEntry> {
  const overrides = await getToggleOverrides();
  return composeDomainContext(PACKS, overrides);
}

/**
 * Returns the composed enabled-pack text and a per-pack summary list.
 *
 * Wave A7 · The build is generation-tagged: if a concurrent
 * `invalidateDomainContextCache()` fires while we're mid-build, we
 * detect the version bump on resolve and rebuild instead of returning
 * stale data. Callers always see the freshest possible state.
 */
export async function loadEnabledDomainContext(): Promise<CacheEntry> {
  if (!cache) {
    const generationAtSpawn = cacheGeneration;
    cache = (async () => {
      try {
        const result = await build();
        // If the generation bumped while we were building (admin
        // toggled a pack mid-flight), discard this result and rebuild.
        // The recursive call hits the new generation and produces fresh
        // data. Bounded recursion: in the worst case the rebuild itself
        // gets invalidated, in which case we just re-rebuild — still
        // converges within the cycle of pending invalidations.
        if (cacheGeneration !== generationAtSpawn) {
          cache = null;
          return loadEnabledDomainContext();
        }
        return result;
      } catch (err) {
        cache = null;
        throw err;
      }
    })();
  }
  return cache;
}

/**
 * Invalidate the memoized result.
 *
 * Wave A7 · Bumps the generation counter so any in-flight build (started
 * before this call) discards its result on resolve and triggers a rebuild
 * against the now-current overrides. New callers see a null cache and
 * trigger their own build.
 */
export function invalidateDomainContextCache(): void {
  cacheGeneration += 1;
  cache = null;
}

/** Test-only: read the current generation counter. */
export function __domainContextGenerationForTesting(): number {
  return cacheGeneration;
}

/** One-shot startup log so operators can see what's loaded. */
export async function logDomainContextStartup(): Promise<void> {
  try {
    const { packs, totalEnabledTokens } = await loadEnabledDomainContext();
    const enabledCount = packs.filter((p) => p.enabled).length;
    logger.log(
      `📚 Domain context: ${enabledCount}/${packs.length} packs enabled, ~${totalEnabledTokens} tokens`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`domainContext: startup log failed (${msg})`);
  }
}
