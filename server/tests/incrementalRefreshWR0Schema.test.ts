/**
 * Wave WR0 (incremental refresh) · schema + flag contract.
 *
 * The incremental-refresh feature adds additive fields to the persisted
 * `Dashboard` write schema (`dataRefreshSource`, `supersedes/supersededBy`)
 * and to the `ChatDocument` interface (`snowflakeSource`, `refreshState`,
 * `dataVersions[].label`). This file pins:
 *   1. Legacy docs (without the new fields) still parse — back-compat.
 *   2. The new dashboard fields SURVIVE a strict `dashboardSchema.parse`
 *      (they must be on the write schema, not just the lenient read schema —
 *      otherwise Zod strips them on persist; cf. L-021).
 *   3. The lenient `chatDocumentReadSchema` passes the new chat fields through.
 *   4. The `INCREMENTAL_REFRESH_ENABLED` flag defaults OFF.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dashboardSchema } from "../shared/schema.js";
import { chatDocumentReadSchema } from "../models/persistedSchemas.js";
import { isIncrementalRefreshEnabled } from "../lib/envFlags.js";
import { FEATURE_FLAGS } from "../lib/featureFlags.js";

const baseDashboard = {
  id: "dash_1",
  username: "u@example.com",
  name: "Q2 Haircare Leadership",
  createdAt: 1,
  updatedAt: 2,
  charts: [],
};

describe("WR0 · dashboard refresh-version fields", () => {
  it("legacy dashboard (no refresh fields) parses unchanged", () => {
    const parsed = dashboardSchema.parse(baseDashboard);
    assert.equal(parsed.dataRefreshSource, undefined);
    assert.equal(parsed.supersedesDashboardId, undefined);
    assert.equal(parsed.supersededByDashboardId, undefined);
  });

  it("new refresh fields survive a strict parse (not stripped — cf. L-021)", () => {
    const withRefresh = {
      ...baseDashboard,
      dataRefreshSource: {
        policy: "append" as const,
        fromDataVersion: 1,
        toDataVersion: 2,
        versionLabel: "Jan+Feb 2026",
        refreshedAt: 1718000000000,
      },
      supersedesDashboardId: "dash_0",
      supersededByDashboardId: "dash_2",
    };
    const parsed = dashboardSchema.parse(withRefresh);
    assert.equal(parsed.dataRefreshSource?.policy, "append");
    assert.equal(parsed.dataRefreshSource?.toDataVersion, 2);
    assert.equal(parsed.dataRefreshSource?.versionLabel, "Jan+Feb 2026");
    assert.equal(parsed.supersedesDashboardId, "dash_0");
    assert.equal(parsed.supersededByDashboardId, "dash_2");
  });

  it("rejects an invalid refresh policy", () => {
    const bad = {
      ...baseDashboard,
      dataRefreshSource: { policy: "merge", refreshedAt: 1 },
    };
    assert.equal(dashboardSchema.safeParse(bad).success, false);
  });
});

describe("WR0 · chat doc refresh fields pass through the lenient read schema", () => {
  it("snowflakeSource + refreshState + dataVersions.label round-trip", () => {
    const doc = {
      id: "u@example.com_1",
      sessionId: "session_1",
      username: "u@example.com",
      messages: [],
      charts: [],
      snowflakeSource: {
        database: "MARICO_DB",
        schema: "SALES",
        tableName: "FACT_SECONDARY",
        importedAt: 1,
      },
      refreshState: {
        status: "complete",
        policy: "replace",
        fromDataVersion: 1,
        toDataVersion: 2,
      },
      dataVersions: [
        { versionId: "v2", blobName: "b", operation: "refresh_replace", description: "May", timestamp: 2, label: "as of May 2026" },
      ],
    };
    const parsed = chatDocumentReadSchema.safeParse(doc);
    assert.equal(parsed.success, true);
    // passthrough must preserve the new fields verbatim
    const out = parsed.success ? (parsed.data as typeof doc) : doc;
    assert.equal(out.snowflakeSource?.tableName, "FACT_SECONDARY");
    assert.equal(out.refreshState?.status, "complete");
    assert.equal(out.dataVersions?.[0]?.label, "as of May 2026");
  });
});

describe("WR0 · feature flag", () => {
  it("INCREMENTAL_REFRESH_ENABLED is registered and defaults OFF", () => {
    assert.equal(FEATURE_FLAGS.INCREMENTAL_REFRESH_ENABLED.default, false);
  });

  it("isIncrementalRefreshEnabled() is OFF when the env var is unset", () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    delete process.env.INCREMENTAL_REFRESH_ENABLED;
    try {
      assert.equal(isIncrementalRefreshEnabled(), false);
    } finally {
      if (prev !== undefined) process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });

  it("isIncrementalRefreshEnabled() is ON for a truthy value (case-insensitive)", () => {
    const prev = process.env.INCREMENTAL_REFRESH_ENABLED;
    process.env.INCREMENTAL_REFRESH_ENABLED = "True";
    try {
      assert.equal(isIncrementalRefreshEnabled(), true);
    } finally {
      if (prev === undefined) delete process.env.INCREMENTAL_REFRESH_ENABLED;
      else process.env.INCREMENTAL_REFRESH_ENABLED = prev;
    }
  });
});
