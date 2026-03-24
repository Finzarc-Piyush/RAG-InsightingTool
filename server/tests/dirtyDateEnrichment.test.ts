import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanedColumnNameForSource,
  computeCleanedDateColumnNames,
  enrichDirtyStringDateColumns,
} from "../lib/dirtyDateEnrichment.js";
import type { DatasetProfile } from "../lib/datasetProfile.js";

describe("cleanedColumnNameForSource", () => {
  it("uses Cleaned_ prefix and resolves collisions", () => {
    const s = new Set(["A", "Cleaned_B"]);
    assert.equal(cleanedColumnNameForSource("B", s), "Cleaned_B_2");
  });
});

describe("computeCleanedDateColumnNames", () => {
  it("orders dirty sources by original column order and respects dateColumns", () => {
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["z", "a"],
      dirtyStringDateColumns: ["a", "z"],
      suggestedQuestions: [],
    };
    const m = computeCleanedDateColumnNames(["a", "b", "z"], profile);
    assert.equal(m.get("a"), "Cleaned_a");
    assert.equal(m.get("z"), "Cleaned_z");
  });
});

describe("enrichDirtyStringDateColumns (injected mapBatch)", () => {
  it("inserts Cleaned_* after source and maps strings to Date", async () => {
    const data = [
      { Period: "Q1 '25", Sales: 1 },
      { Period: "Q2 '25", Sales: 2 },
    ];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Period"],
      dirtyStringDateColumns: ["Period"],
      suggestedQuestions: [],
    };
    const originalKeys = Object.keys(data[0]!);
    await enrichDirtyStringDateColumns(data, profile, originalKeys, {
      mapBatch: async ({ values }) => {
        const map = new Map<string, string | null>();
        for (const v of values) {
          if (v === "Q1 '25") map.set(v, "2025-01-01");
          else if (v === "Q2 '25") map.set(v, "2025-04-01");
          else map.set(v, null);
        }
        return { ok: true as const, map };
      },
    });
    assert.ok(data[0]!["Cleaned_Period"] instanceof Date);
    assert.equal((data[0]!["Cleaned_Period"] as Date).toISOString().slice(0, 10), "2025-01-01");
    const keys = Object.keys(data[0]!);
    const iPeriod = keys.indexOf("Period");
    const iClean = keys.indexOf("Cleaned_Period");
    assert.ok(iClean === iPeriod + 1, "Cleaned_* should follow source column");
  });

  it("copies original string when iso is null", async () => {
    const data = [{ Period: "???", Sales: 1 }];
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Period"],
      dirtyStringDateColumns: ["Period"],
      suggestedQuestions: [],
    };
    await enrichDirtyStringDateColumns(data, profile, Object.keys(data[0]!), {
      mapBatch: async ({ values }) => {
        const map = new Map<string, string | null>();
        for (const v of values) map.set(v, null);
        return { ok: true as const, map };
      },
    });
    assert.equal(data[0]!["Cleaned_Period"], "???");
  });
});
