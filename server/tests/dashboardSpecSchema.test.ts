import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  createDashboardFromSpecRequestSchema,
  dashboardSpecSchema,
  type DashboardSpec,
} from "../shared/schema.js";

function baseSpec(overrides: Partial<DashboardSpec> = {}): DashboardSpec {
  return {
    name: "Sales deep dive",
    template: "deep_dive",
    sheets: [
      {
        id: "sheet_summary",
        name: "Summary",
        narrativeBlocks: [
          {
            id: "n1",
            role: "summary",
            title: "Executive summary",
            body: "Sales fell 12% in East for tech products in Mar–Apr.",
            order: 0,
          },
        ],
      },
      {
        id: "sheet_evidence",
        name: "Evidence",
        charts: [],
      },
    ],
    defaultSheetId: "sheet_summary",
    ...overrides,
  };
}

describe("dashboardSpecSchema (Phase 2)", () => {
  it("accepts a minimal two-sheet executive spec", () => {
    const parsed = dashboardSpecSchema.safeParse({
      name: "Q4 snapshot",
      template: "executive",
      sheets: [{ id: "s1", name: "Summary", charts: [] }],
    });
    assert.equal(parsed.success, true);
  });

  it("rejects empty sheet arrays", () => {
    const parsed = dashboardSpecSchema.safeParse({
      name: "x",
      template: "executive",
      sheets: [],
    });
    assert.equal(parsed.success, false);
  });

  it("caps sheet count at 6", () => {
    const sheets = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      name: `Sheet ${i}`,
      charts: [],
    }));
    const parsed = dashboardSpecSchema.safeParse({
      name: "too big",
      template: "deep_dive",
      sheets,
    });
    assert.equal(parsed.success, false);
  });

  it("rejects unknown template values", () => {
    const parsed = dashboardSpecSchema.safeParse({
      name: "x",
      template: "brand_new",
      sheets: [{ id: "s1", name: "S", charts: [] }],
    });
    assert.equal(parsed.success, false);
  });

  it("round-trips via the /from-spec request schema", () => {
    const req = createDashboardFromSpecRequestSchema.safeParse({
      spec: baseSpec(),
    });
    assert.equal(req.success, true);
  });
});
