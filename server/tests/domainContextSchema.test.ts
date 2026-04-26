import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parsePack, PackParseError } from "../lib/domainContext/packSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(HERE, "..", "lib", "domainContext", "packs");

test("parsePack: round-trips the company-profile fixture", () => {
  const file = "marico-company-profile.md";
  const source = readFileSync(join(PACKS_DIR, file), "utf8");
  const pack = parsePack({ file, source });
  assert.equal(pack.id, "marico-company-profile");
  assert.equal(pack.category, "products");
  assert.equal(pack.priority, 1);
  assert.equal(pack.enabledByDefault, true);
  assert.ok(pack.body.includes("Marico Limited"));
  assert.ok(pack.approxTokens > 0);
});

test("parsePack: rejects missing opening fence", () => {
  assert.throws(
    () =>
      parsePack({
        file: "broken.md",
        source: "id: broken\ntitle: Broken\n---\nbody",
      }),
    PackParseError
  );
});

test("parsePack: rejects unknown category", () => {
  const source = [
    "---",
    "id: bad-category",
    "title: Bad",
    "category: not-a-real-category",
    "priority: 1",
    "enabledByDefault: true",
    "version: 2026-01-01",
    "---",
    "body",
  ].join("\n");
  assert.throws(() => parsePack({ file: "bad-category.md", source }), PackParseError);
});

test("parsePack: id must match filename stem", () => {
  const source = [
    "---",
    "id: actual-id",
    "title: T",
    "category: glossary",
    "priority: 1",
    "enabledByDefault: false",
    "version: v1",
    "---",
    "body",
  ].join("\n");
  assert.throws(
    () => parsePack({ file: "different-name.md", source }),
    /must match filename/
  );
});

test("parsePack: rejects empty body", () => {
  const source = [
    "---",
    "id: empty-body",
    "title: T",
    "category: glossary",
    "priority: 0",
    "enabledByDefault: false",
    "version: v1",
    "---",
    "   \n  ",
  ].join("\n");
  assert.throws(() => parsePack({ file: "empty-body.md", source }), PackParseError);
});
