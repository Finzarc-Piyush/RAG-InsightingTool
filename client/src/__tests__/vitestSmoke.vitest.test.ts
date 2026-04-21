import { describe, expect, it } from "vitest";

/**
 * Smoke test proving the vitest runner boots + Vite aliases work.
 * Deliberately trivial; richer component tests (React Testing Library,
 * jsdom) arrive alongside the first migration of a node:test file.
 */
describe("vitest smoke", () => {
  it("runs at all", () => {
    expect(1 + 1).toBe(2);
  });

  it("resolves the @/ alias", async () => {
    // @/lib/utils.ts exports `cn` — sanity-check alias resolution.
    const mod = await import("@/lib/utils");
    expect(typeof mod.cn).toBe("function");
  });
});
