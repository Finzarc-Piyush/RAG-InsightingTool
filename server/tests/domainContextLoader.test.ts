import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadEnabledDomainContext,
  invalidateDomainContextCache,
} from "../lib/domainContext/loadEnabledDomainContext.js";

// In this test process Cosmos is not configured (toggle store returns {}),
// so every pack falls back to its frontmatter `enabledByDefault`. All 12 of
// our authored packs default to enabled, which is what we assert below.

test("loadEnabledDomainContext: composes all 13 packs by default", async () => {
  invalidateDomainContextCache();
  const result = await loadEnabledDomainContext();
  assert.equal(result.packs.length, 13);
  assert.equal(
    result.packs.filter((p) => p.enabled).length,
    13,
    "all packs should default to enabled with no Cosmos overrides"
  );
  assert.ok(result.text.includes("<<DOMAIN PACK: marico-company-profile>>"));
  assert.ok(result.text.includes("<<DOMAIN PACK: marico-vietnam-portfolio>>"));
  assert.ok(result.text.includes("<<DOMAIN PACK: geography-and-channel-codes>>"));
  assert.ok(result.totalEnabledTokens > 0);
});

test("loadEnabledDomainContext: results are sorted by priority", async () => {
  invalidateDomainContextCache();
  const result = await loadEnabledDomainContext();
  // Priority is monotonically non-decreasing in the summaries array.
  for (let i = 1; i < result.packs.length; i++) {
    assert.ok(
      result.packs[i].priority >= result.packs[i - 1].priority,
      `packs[${i}] (${result.packs[i].id} pri=${result.packs[i].priority}) ` +
        `must come after packs[${i - 1}] (${result.packs[i - 1].id} pri=${result.packs[i - 1].priority})`
    );
  }
  // First emitted block in the text is the lowest-priority pack.
  const firstMarker = result.text.indexOf("<<DOMAIN PACK:");
  const firstBlock = result.text.slice(firstMarker, firstMarker + 80);
  assert.ok(firstBlock.includes(result.packs[0].id));
});

test("loadEnabledDomainContext: cache invalidation forces rebuild", async () => {
  invalidateDomainContextCache();
  const a = await loadEnabledDomainContext();
  const b = await loadEnabledDomainContext();
  // Same memoised promise → same object reference.
  assert.strictEqual(a, b);
  invalidateDomainContextCache();
  const c = await loadEnabledDomainContext();
  // Different promise after invalidation → different reference.
  assert.notStrictEqual(a, c);
  // But same content (same overrides, same packs).
  assert.equal(a.text, c.text);
});

test("composeDomainContext: empty body when overrides disable everything", async () => {
  const { PACKS } = await import("../lib/domainContext/generatedPacks.js");
  const { composeDomainContext } = await import(
    "../lib/domainContext/loadEnabledDomainContext.js"
  );
  const allFalse = Object.fromEntries(PACKS.map((p) => [p.id, false]));
  const result = composeDomainContext(PACKS, allFalse);
  assert.equal(result.text, "");
  assert.equal(result.totalEnabledTokens, 0);
  assert.equal(result.packs.filter((p) => p.enabled).length, 0);
});

test("composeDomainContext: override flips a single pack", async () => {
  const { PACKS } = await import("../lib/domainContext/generatedPacks.js");
  const { composeDomainContext } = await import(
    "../lib/domainContext/loadEnabledDomainContext.js"
  );
  const result = composeDomainContext(PACKS, { "marico-haircare-portfolio": false });
  assert.equal(result.packs.length, 13);
  const haircare = result.packs.find((p) => p.id === "marico-haircare-portfolio");
  assert.ok(haircare && haircare.enabled === false);
  assert.equal(haircare.defaultEnabled, true);
  assert.ok(!result.text.includes("<<DOMAIN PACK: marico-haircare-portfolio>>"));
  assert.ok(result.text.includes("<<DOMAIN PACK: marico-company-profile>>"));
});
