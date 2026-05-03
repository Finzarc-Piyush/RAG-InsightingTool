import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dimensionHierarchySchema,
  sessionAnalysisContextSchema,
  type SessionAnalysisContext,
} from "../shared/schema.js";

describe("dimensionHierarchies — H1 schema", () => {
  it("round-trips a user-declared hierarchy with full payload", () => {
    const input = {
      column: "Products",
      rollupValue: "FEMALE SHOWER GEL",
      itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
      source: "user" as const,
      description: "FEMALE SHOWER GEL is the entire category; the rest are products within it.",
    };
    const parsed = dimensionHierarchySchema.parse(input);
    assert.deepEqual(parsed, input);
  });

  it("defaults source to 'user' when omitted", () => {
    const parsed = dimensionHierarchySchema.parse({
      column: "Region",
      rollupValue: "All Regions",
    });
    assert.equal(parsed.source, "user");
    assert.equal(parsed.itemValues, undefined);
    assert.equal(parsed.description, undefined);
  });

  it("backwards compat: SAC docs with no dimensionHierarchies field still parse", () => {
    const legacy: SessionAnalysisContext = {
      version: 1,
      dataset: {
        shortDescription: "Legacy dataset.",
        columnRoles: [],
        caveats: [],
      },
      userIntent: { interpretedConstraints: [] },
      sessionKnowledge: { facts: [], analysesDone: [] },
      suggestedFollowUps: [],
      lastUpdated: { reason: "seed", at: "2026-04-29T00:00:00.000Z" },
    };
    const parsed = sessionAnalysisContextSchema.parse(legacy);
    assert.equal(parsed.dataset.dimensionHierarchies, undefined);
  });

  it("SAC accepts an array of hierarchies", () => {
    const ctx: SessionAnalysisContext = {
      version: 1,
      dataset: {
        shortDescription: "Marico-VN sales by product.",
        columnRoles: [],
        caveats: [],
        dimensionHierarchies: [
          {
            column: "Products",
            rollupValue: "FEMALE SHOWER GEL",
            itemValues: ["MARICO", "PURITE"],
            source: "user",
          },
        ],
      },
      userIntent: { interpretedConstraints: [] },
      sessionKnowledge: { facts: [], analysesDone: [] },
      suggestedFollowUps: [],
      lastUpdated: { reason: "user_context", at: "2026-04-29T00:00:00.000Z" },
    };
    const parsed = sessionAnalysisContextSchema.parse(ctx);
    assert.equal(parsed.dataset.dimensionHierarchies?.length, 1);
    assert.equal(parsed.dataset.dimensionHierarchies?.[0]?.rollupValue, "FEMALE SHOWER GEL");
  });

  it("rejects empty column or rollupValue", () => {
    assert.throws(() =>
      dimensionHierarchySchema.parse({ column: "", rollupValue: "FEMALE SHOWER GEL" }),
    );
    // zod's max() doesn't enforce min — but undefined fields are caught:
    assert.throws(() =>
      dimensionHierarchySchema.parse({ column: "Products" } as unknown as Record<string, unknown>),
    );
  });
});
