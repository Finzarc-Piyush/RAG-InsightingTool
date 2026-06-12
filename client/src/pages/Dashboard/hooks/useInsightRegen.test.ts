/**
 * Wave WI2-wire · source-inspection + cache-shape tests for the
 * `useInsightRegen` hook and the `TileInsightFooter` regen surface.
 *
 * The hook is React-shaped (uses useMemo / useCallback / useState /
 * useRef), so we don't render it through node:test directly — the
 * source-level pins guard the load-bearing decisions: cache key
 * derivation, response → cache shape parity, regenerate() bypass,
 * and the stale-resolve `seqRef` guard. The end-to-end cache+server
 * round-trip is already pinned at the layers below (WI2-cache tests
 * + WI2-server tests).
 *
 * The companion `TileInsightFooter` change is also source-inspected:
 * the regen entry text takes precedence over the static keyInsight,
 * a "Re-explain this view" button renders only when `regen` is
 * provided, and the spinner / error / metadata states are wired.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const hookSrc = readFileSync(
  repoFile("./useInsightRegen.ts"),
  "utf-8",
);
const footerSrc = readFileSync(
  repoFile("../Components/TileInsightFooter.tsx"),
  "utf-8",
);

describe("WI2-wire · useInsightRegen hook shape", () => {
  it("imports the WI2-cache helpers + type from the canonical module", () => {
    assert.match(
      hookSrc,
      /import \{[\s\S]*?buildCacheKey,[\s\S]*?createInsightRegenCache,[\s\S]*?hashBrushRegion,[\s\S]*?hashGlobalFilters,[\s\S]*?\} from "\.\.\/lib\/insightRegenCache"/,
    );
  });

  it("imports the BrushRegion type from the WI4 explainSlice module (Wave WI4-cache-key)", () => {
    assert.match(
      hookSrc,
      /import\s+type\s+\{\s*BrushRegion\s*\}\s+from\s+"\.\.\/lib\/explainSlice"/,
    );
  });

  it("derives `cacheKey = buildCacheKey(tileId, hashGlobalFilters(filters), hashBrushRegion(brushRegion))` via useMemo (Wave WI4-cache-key)", () => {
    // Wave WI4-cache-key widens the cache key to three segments so
    // two brushes on the same (tile, filters) but different
    // sub-regions never silently collide on the same slot. The
    // previous two-arg shape is still backwards-compatible via
    // buildCacheKey's optional third arg + hashBrushRegion(undefined)
    // returning the empty string.
    assert.match(
      hookSrc,
      /const cacheKey = useMemo\(\s*\(\) =>\s*buildCacheKey\(\s*tileId,\s*hashGlobalFilters\(filters\),\s*hashBrushRegion\(brushRegion\),?\s*\),\s*\[tileId, filters, brushRegion\],\s*\);/,
    );
  });

  it("destructures `brushRegion` alongside `tileId` + `filters` from args (Wave WI4-cache-key)", () => {
    assert.match(
      hookSrc,
      /const \{ tileId, filters, brushRegion \} = args;/,
    );
  });

  it("reads the cached entry synchronously on every render", () => {
    assert.match(hookSrc, /const entry = cache\.get\(cacheKey\);/);
  });

  it("regenerate() checks the cache first and returns the cached entry on hit", () => {
    assert.match(
      hookSrc,
      /if \(!bypass\) \{[\s\S]*?const cached = cache\.get\(cacheKey\);[\s\S]*?if \(cached\) return cached;[\s\S]*?\}/,
    );
  });

  it("regenerate() POSTs to /api/insight/regen with credentials:include", () => {
    assert.match(
      hookSrc,
      /await fetch\("\/api\/insight\/regen", \{[\s\S]*?method: "POST",[\s\S]*?credentials: "include",[\s\S]*?headers: \{ "Content-Type": "application\/json" \},[\s\S]*?body: JSON\.stringify\(body\),[\s\S]*?\}\);/,
    );
  });

  it("response is merged into the cache via cache.set with no transformation", () => {
    // Endpoint shape was designed to match InsightRegenEntry byte-for-byte;
    // any transformation here would be a contract violation.
    assert.match(hookSrc, /const parsed = \(await res\.json\(\)\) as InsightRegenEntry;[\s\S]*?cache\.set\(cacheKey, parsed\);/);
  });

  it("a seqRef guards against stale resolves clobbering newer loading/error state", () => {
    assert.match(hookSrc, /const seqRef = useRef\(0\);/);
    assert.match(hookSrc, /const seq = \+\+seqRef\.current;/);
    assert.match(hookSrc, /if \(seq === seqRef\.current\) \{[\s\S]*?setLoading\(false\);/);
  });

  it("bypassCache option lets the caller force a fresh network call", () => {
    assert.match(hookSrc, /const bypass = options\?\.bypassCache \?\? false;/);
  });

  it("domainContext / datasetContextHint are conditionally included in the request body", () => {
    // Spread-conditional shape so undefined optional fields don't ship `null` to a strict zod schema.
    assert.match(hookSrc, /\.\.\.\(options\?\.domainContext \? \{ domainContext: options\.domainContext \} : \{\}\),/);
    assert.match(
      hookSrc,
      /\.\.\.\(options\?\.datasetContextHint\s*\?\s*\{ datasetContextHint: options\.datasetContextHint \}\s*:\s*\{\}\),/,
    );
  });

  it("a fallback per-mount cache is created via useMemo with empty deps when none is injected", () => {
    assert.match(hookSrc, /const fallbackCache = useMemo\(\(\) => createInsightRegenCache\(\), \[\]\);/);
    assert.match(hookSrc, /const cache = args\.cache \?\? fallbackCache;/);
  });

  it("safeReadError prefers a string `error` field in the JSON body, falling back to status text", () => {
    assert.match(hookSrc, /if \(typeof body\?\.error === "string"\) return body\.error;/);
    assert.match(hookSrc, /return `Regen failed \(\$\{res\.status\}\)`;/);
  });
});

describe("WI2-wire · TileInsightFooter regen surface", () => {
  it("imports InsightRegenEntry type from the WI2-cache module", () => {
    assert.match(
      footerSrc,
      /import type \{ InsightRegenEntry \} from "\.\.\/lib\/insightRegenCache";/,
    );
  });

  it("imports the Loader2 + Sparkles icons for the button states", () => {
    assert.match(footerSrc, /import \{[\s\S]*?Loader2[\s\S]*?Sparkles[\s\S]*?\} from "lucide-react";/);
  });

  it("exports a TileInsightFooterRegenProps shape with { entry, loading, error, onRegenerate }", () => {
    assert.match(
      footerSrc,
      /export interface TileInsightFooterRegenProps \{[\s\S]*?entry: InsightRegenEntry \| undefined;[\s\S]*?loading: boolean;[\s\S]*?error: string \| null;[\s\S]*?onRegenerate: \(\) => void;[\s\S]*?\}/,
    );
  });

  it("optional `regen` prop on the footer (omitting it preserves the legacy passive footer)", () => {
    assert.match(footerSrc, /regen\?: TileInsightFooterRegenProps;/);
  });

  it("regenerated entry text takes precedence over the static keyInsight", () => {
    // The footer prose comes from `pickFooterText(regen?.entry?.text, insight)`
    // (a fresh regen entry wins over the static keyInsight — see
    // insightFooterState.pickFooterText) and renders via MarkdownRenderer, so
    // the static prose stays visible until the first regen lands.
    assert.match(footerSrc, /pickFooterText\(regen\?\.entry\?\.text, insight\)/);
    assert.match(footerSrc, /<MarkdownRenderer content=\{footerText\} \/>/);
  });

  it("Re-explain button renders only when `regen` is provided", () => {
    // The whole {regen ? <button…/> : null} block lives only inside
    // the open-footer branch and the conditional is the predicate.
    assert.match(footerSrc, /\{regen \? \([\s\S]*?Re-explain this view[\s\S]*?\)/);
  });

  it("button toggles between Sparkles (idle) and Loader2 spin (loading) based on regen.loading", () => {
    assert.match(footerSrc, /\{regen\.loading \? \(\s*<Loader2/);
    assert.match(footerSrc, /<Sparkles className="mr-1 h-3 w-3" aria-hidden="true" \/>/);
  });

  it("button is disabled while loading + stops propagation to keep the footer toggle quiet", () => {
    assert.match(footerSrc, /disabled=\{regen\.loading\}/);
    assert.match(footerSrc, /e\.stopPropagation\(\);\s*regen\.onRegenerate\(\);/);
  });

  it("error message renders with role=\"alert\" so a11y tools announce it", () => {
    assert.match(
      footerSrc,
      /<span\s+role="alert"\s+className="text-\[11px\] text-destructive"\s*>\s*\{regen\.error\}/,
    );
  });

  it('regen entry metadata renders "Updated <relative>" + confidence tier when present', () => {
    assert.match(
      footerSrc,
      /\{regen\?\.entry\?\.regeneratedAt \? \([\s\S]*?Updated \{formatRelativeShort\(regen\.entry\.regeneratedAt\)\}/,
    );
    assert.match(
      footerSrc,
      /regen\.entry\.confidenceTier[\s\S]*?\$\{regen\.entry\.confidenceTier\} confidence/,
    );
  });

  it("formatRelativeShort returns ms-relative short labels for common windows", () => {
    assert.match(footerSrc, /if \(seconds < 60\) return `\$\{seconds\}s ago`;/);
    assert.match(footerSrc, /if \(minutes < 60\) return `\$\{minutes\} min ago`;/);
    assert.match(footerSrc, /if \(hours < 24\) return `\$\{hours\} h ago`;/);
    assert.match(footerSrc, /return `\$\{days\} d ago`;/);
  });
});
