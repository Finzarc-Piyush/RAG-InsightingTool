import { describe, it, expect } from "vitest";
import { normalizeDashboard } from "./useDashboardState";
import type { Dashboard as ServerDashboard } from "@/shared/schema";

/**
 * DR17 · `normalizeDashboard` strips the legacy "Step N" narrative
 * blocks at read time so dashboards persisted before the server-side
 * fix render clean without a Cosmos migration. The match is
 * intentionally narrow — title is exactly "Step <number>" — so
 * legitimate user-authored notes whose title happens to start with
 * "Step" are preserved.
 */

const minimal = (overrides: Partial<ServerDashboard> = {}): ServerDashboard => ({
  id: "d1",
  username: "u@example.com",
  name: "Sales Dashboard",
  createdAt: 1,
  updatedAt: 2,
  charts: [],
  ...overrides,
});

describe("DR17 · normalizeDashboard strips legacy Step N narrative blocks", () => {
  it("removes blocks whose title is `Step <number>`", () => {
    const out = normalizeDashboard(
      minimal({
        sheets: [
          {
            id: "sheet_all",
            name: "All Artefacts",
            charts: [],
            narrativeBlocks: [
              { id: "n1", role: "custom", title: "Step 1", body: "tool dump", order: 0 },
              { id: "n2", role: "custom", title: "Step 12", body: "more", order: 1 },
              { id: "n3", role: "summary", title: "Headline", body: "real", order: 2 },
            ],
            order: 0,
          },
        ],
      }),
    );
    const blocks = out.sheets?.[0]?.narrativeBlocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe("Headline");
  });

  it("matches case-insensitively (`step 1`, `STEP 1` both stripped)", () => {
    const out = normalizeDashboard(
      minimal({
        sheets: [
          {
            id: "s",
            name: "S",
            charts: [],
            narrativeBlocks: [
              { id: "a", role: "custom", title: "step 1", body: "x", order: 0 },
              { id: "b", role: "custom", title: "STEP 2", body: "x", order: 1 },
              { id: "c", role: "custom", title: "Step  3", body: "x", order: 2 },
            ],
            order: 0,
          },
        ],
      }),
    );
    expect(out.sheets?.[0]?.narrativeBlocks ?? []).toEqual([]);
  });

  it("preserves user-authored notes whose title only starts with 'Step'", () => {
    const out = normalizeDashboard(
      minimal({
        sheets: [
          {
            id: "s",
            name: "S",
            charts: [],
            narrativeBlocks: [
              { id: "a", role: "custom", title: "Steps to act on", body: "...", order: 0 },
              { id: "b", role: "custom", title: "Step-by-step plan", body: "...", order: 1 },
              { id: "c", role: "custom", title: "Step 4", body: "tool dump", order: 2 },
            ],
            order: 0,
          },
        ],
      }),
    );
    const blocks = out.sheets?.[0]?.narrativeBlocks ?? [];
    expect(blocks.map((b) => b.title)).toEqual([
      "Steps to act on",
      "Step-by-step plan",
    ]);
  });

  it("leaves sheets without narrativeBlocks untouched", () => {
    const out = normalizeDashboard(
      minimal({
        sheets: [{ id: "s", name: "S", charts: [], order: 0 }],
      }),
    );
    expect(out.sheets?.[0]?.narrativeBlocks).toBeUndefined();
  });

  it("returns the same array reference when nothing was stripped (no needless re-allocation)", () => {
    const original = [
      { id: "a", role: "summary" as const, title: "Headline", body: "real", order: 0 },
    ];
    const out = normalizeDashboard(
      minimal({
        sheets: [
          {
            id: "s",
            name: "S",
            charts: [],
            narrativeBlocks: original,
            order: 0,
          },
        ],
      }),
    );
    // The inner sheet is rebuilt only when blocks were removed; here it
    // wasn't, so the narrativeBlocks array passes through identity-stable.
    expect(out.sheets?.[0]?.narrativeBlocks).toBe(original);
  });
});
