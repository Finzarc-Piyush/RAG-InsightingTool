/**
 * WD3 · Pack discovery.
 *
 * Reads `*.md` files from the packs directory, parses frontmatter, validates
 * with zod, and returns a sorted list. Bad frontmatter is logged and skipped
 * (mirrors `costRollups.ts:ensureContainer` defensive pattern) so a single
 * malformed pack cannot block server boot.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parsePack, PackParseError } from "./packSchema.js";
import type { DomainPack } from "./types.js";

export interface DiscoverResult {
  /** Successfully parsed and validated packs, sorted by priority. */
  packs: DomainPack[];
  /** Filenames that failed to parse, with the reason. */
  errors: Array<{ file: string; reason: string }>;
}

export function discoverPacks(packsDir: string): DiscoverResult {
  const packs: DomainPack[] = [];
  const errors: Array<{ file: string; reason: string }> = [];

  let entries: string[];
  try {
    entries = readdirSync(packsDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`domainContext: cannot read packs dir ${packsDir} (${reason})`);
    return { packs, errors: [{ file: packsDir, reason }] };
  }

  const ids = new Set<string>();
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    try {
      const source = readFileSync(join(packsDir, file), "utf8");
      const pack = parsePack({ file, source });
      if (ids.has(pack.id)) {
        const reason = `duplicate id "${pack.id}"`;
        console.warn(`domainContext: skipping ${file} — ${reason}`);
        errors.push({ file, reason });
        continue;
      }
      ids.add(pack.id);
      packs.push(pack);
    } catch (err) {
      const reason =
        err instanceof PackParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(`domainContext: skipping ${file} — ${reason}`);
      errors.push({ file, reason });
    }
  }

  packs.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return { packs, errors };
}
