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

const TOKEN_BUDGET_WARN = 12_000;

interface CacheEntry {
  text: string;
  packs: PackSummary[];
  totalEnabledTokens: number;
}

let cache: Promise<CacheEntry> | null = null;

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
    console.warn(
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

/** Returns the composed enabled-pack text and a per-pack summary list. */
export async function loadEnabledDomainContext(): Promise<CacheEntry> {
  if (!cache) {
    cache = build().catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}

/** Invalidate the memoized result (call from the admin PATCH handler). */
export function invalidateDomainContextCache(): void {
  cache = null;
}

/** One-shot startup log so operators can see what's loaded. */
export async function logDomainContextStartup(): Promise<void> {
  try {
    const { packs, totalEnabledTokens } = await loadEnabledDomainContext();
    const enabledCount = packs.filter((p) => p.enabled).length;
    console.log(
      `📚 Domain context: ${enabledCount}/${packs.length} packs enabled, ~${totalEnabledTokens} tokens`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`domainContext: startup log failed (${msg})`);
  }
}
