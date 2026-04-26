import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { discoverPacks } from "../lib/domainContext/discoverPacks.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_PACKS_DIR = join(HERE, "..", "lib", "domainContext", "packs");

function tmp(prefix = "domain-context-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writePack(dir: string, file: string, body: string): void {
  writeFileSync(join(dir, file), body, "utf8");
}

const VALID = (id: string, priority = 1) =>
  [
    "---",
    `id: ${id}`,
    "title: T",
    "category: glossary",
    `priority: ${priority}`,
    "enabledByDefault: true",
    "version: 2026-01-01",
    "---",
    "Body content here.",
  ].join("\n");

test("discoverPacks: discovers and sorts the real packs by priority", () => {
  const result = discoverPacks(REAL_PACKS_DIR);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.packs.length, 13);
  assert.equal(result.packs[0].id, "marico-company-profile");
  assert.equal(result.packs[result.packs.length - 1].id, "geography-and-channel-codes");
  // Vietnam pack sits at priority 5 — between the four India brand pillars
  // and the broader market context packs.
  assert.equal(result.packs[4].id, "marico-vietnam-portfolio");
  for (let i = 1; i < result.packs.length; i++) {
    assert.ok(result.packs[i].priority >= result.packs[i - 1].priority);
  }
});

test("discoverPacks: skips bad frontmatter, returns the rest", () => {
  const dir = tmp();
  try {
    writePack(dir, "good-one.md", VALID("good-one", 1));
    writePack(dir, "good-two.md", VALID("good-two", 2));
    writePack(dir, "bad-no-fence.md", "id: bad-no-fence\nbody only");
    const result = discoverPacks(dir);
    assert.equal(result.packs.length, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].file, "bad-no-fence.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPacks: dedupes on id (keeps the first, logs the second)", () => {
  const dir = tmp();
  try {
    writePack(dir, "first.md", VALID("first", 1));
    // Second file with mismatched filename will fail id-vs-filename check first;
    // craft a real duplicate by writing the same id under a different filename.
    writePack(
      dir,
      "duplicate-of-first.md",
      [
        "---",
        "id: duplicate-of-first",
        "title: T",
        "category: glossary",
        "priority: 5",
        "enabledByDefault: true",
        "version: 2026-01-01",
        "---",
        "Body.",
      ].join("\n")
    );
    const result = discoverPacks(dir);
    assert.equal(result.packs.length, 2);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverPacks: missing dir returns empty + error (does not throw)", () => {
  const result = discoverPacks("/nonexistent/path/does/not/exist");
  assert.equal(result.packs.length, 0);
  assert.equal(result.errors.length, 1);
});
