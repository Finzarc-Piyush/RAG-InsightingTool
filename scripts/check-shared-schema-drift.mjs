#!/usr/bin/env node
/**
 * P-059: CI gate for shared schema drift.
 *
 * server/shared/schema.ts and client/src/shared/schema.ts are expected to
 * mirror each other (the types, at least). This script normalizes whitespace
 * and line-only comments, then hashes both files. Mismatch fails CI.
 *
 * Run: node scripts/check-shared-schema-drift.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const serverPath = resolve(repoRoot, "server/shared/schema.ts");
const clientPath = resolve(repoRoot, "client/src/shared/schema.ts");

function normalize(source) {
  return source
    // strip /* ... */ block comments first (may contain // sequences)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // strip // to end-of-line (both full-line and trailing inline comments)
    .replace(/\/\/.*$/gm, "")
    // collapse all whitespace to a single space
    .replace(/\s+/g, " ")
    .trim();
}

function hash(path) {
  const raw = readFileSync(path, "utf8");
  return createHash("sha256").update(normalize(raw)).digest("hex");
}

const serverHash = hash(serverPath);
const clientHash = hash(clientPath);

if (serverHash !== clientHash) {
  console.error(
    `❌ Shared schema drift detected:\n  server hash = ${serverHash}\n  client hash = ${clientHash}\n` +
      `Update both files in lock-step.\n  server/shared/schema.ts\n  client/src/shared/schema.ts`
  );
  process.exit(1);
}
console.log(`✅ Shared schema hashes match (${serverHash.slice(0, 12)}…)`);
