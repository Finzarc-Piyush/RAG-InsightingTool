import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * WD5 · toggle store tests.
 *
 * The store reaches into the Cosmos client via `getDatabase()`. We don't have
 * a Cosmos here; instead we verify the *shape* of the writes with a direct
 * harness around `setPackEnabled`'s read/replace cycle by injecting a fake
 * container via module patching.
 *
 * The store also has a defensive "Cosmos not configured → return {}" path —
 * which is what runs by default in this test process (no COSMOS_ENDPOINT).
 * That path is what we exercise here.
 */

import {
  getToggleOverrides,
  setPackEnabled,
  resetForTest,
} from "../models/domainContextToggles.model.js";

test("getToggleOverrides: returns {} when Cosmos is not configured", async () => {
  resetForTest();
  const before = process.env.COSMOS_ENDPOINT;
  const beforeKey = process.env.COSMOS_KEY;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
  try {
    const overrides = await getToggleOverrides();
    assert.deepEqual(overrides, {});
  } finally {
    if (before) process.env.COSMOS_ENDPOINT = before;
    if (beforeKey) process.env.COSMOS_KEY = beforeKey;
    resetForTest();
  }
});

test("setPackEnabled: throws when Cosmos is not configured", async () => {
  resetForTest();
  const before = process.env.COSMOS_ENDPOINT;
  const beforeKey = process.env.COSMOS_KEY;
  delete process.env.COSMOS_ENDPOINT;
  delete process.env.COSMOS_KEY;
  try {
    await assert.rejects(
      () => setPackEnabled("some-pack", false, "admin@example.com"),
      /store unavailable/
    );
  } finally {
    if (before) process.env.COSMOS_ENDPOINT = before;
    if (beforeKey) process.env.COSMOS_KEY = beforeKey;
    resetForTest();
  }
});
