import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRequiredEnv } from "../config/env.js";

/**
 * EX21 / CFG-1 · boot-time env validation. Fail-fast (throw) in a
 * production-like environment with an aggregated message; warn-only in dev/test.
 */

const KEYS = [
  "NODE_ENV",
  "VERCEL",
  "DISABLE_AUTH",
  "COSMOS_ENDPOINT",
  "COSMOS_KEY",
  "AZURE_STORAGE_ACCOUNT_NAME",
  "AZURE_STORAGE_ACCOUNT_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT_NAME",
  "AZURE_AD_TENANT_ID",
  "AZURE_AD_CLIENT_ID",
];

function withEnv(overrides: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) process.env[k] = v;
  try {
    run();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

const ALL_CREDS = {
  COSMOS_ENDPOINT: "https://x",
  COSMOS_KEY: "k",
  AZURE_STORAGE_ACCOUNT_NAME: "acct",
  AZURE_STORAGE_ACCOUNT_KEY: "key",
  AZURE_OPENAI_ENDPOINT: "https://oai",
  AZURE_OPENAI_API_KEY: "k",
  AZURE_OPENAI_DEPLOYMENT_NAME: "gpt",
  AZURE_AD_TENANT_ID: "t",
  AZURE_AD_CLIENT_ID: "c",
};

test("CFG-1: throws in production when a required credential is missing", () => {
  withEnv({ ...ALL_CREDS, NODE_ENV: "production", COSMOS_ENDPOINT: undefined }, () => {
    assert.throws(() => assertRequiredEnv(), /COSMOS_ENDPOINT/);
  });
});

test("CFG-1: aggregates ALL missing vars into one error", () => {
  withEnv({ NODE_ENV: "production" }, () => {
    assert.throws(
      () => assertRequiredEnv(),
      (e: unknown) => {
        const m = e instanceof Error ? e.message : "";
        return /COSMOS_ENDPOINT/.test(m) && /AZURE_OPENAI_API_KEY/.test(m) && /AZURE_AD_CLIENT_ID/.test(m);
      },
    );
  });
});

test("CFG-1: passes in production when all credentials present", () => {
  withEnv({ ...ALL_CREDS, NODE_ENV: "production" }, () => {
    assert.doesNotThrow(() => assertRequiredEnv());
  });
});

test("CFG-1: dev/test only warns (never throws) on missing creds", () => {
  withEnv({ NODE_ENV: "development" }, () => {
    assert.doesNotThrow(() => assertRequiredEnv());
  });
});

test("CFG-1: Azure AD not required when DISABLE_AUTH=true", () => {
  withEnv(
    {
      ...ALL_CREDS,
      NODE_ENV: "production",
      DISABLE_AUTH: "true",
      AZURE_AD_TENANT_ID: undefined,
      AZURE_AD_CLIENT_ID: undefined,
    },
    () => {
      assert.doesNotThrow(() => assertRequiredEnv());
    },
  );
});

test("CFG-1: Vercel is treated as production-like (throws on missing)", () => {
  withEnv({ VERCEL: "1", COSMOS_ENDPOINT: undefined }, () => {
    assert.throws(() => assertRequiredEnv(), /COSMOS_ENDPOINT/);
  });
});
