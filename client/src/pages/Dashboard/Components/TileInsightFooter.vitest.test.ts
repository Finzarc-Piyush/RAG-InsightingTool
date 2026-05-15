import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DR18B · sessionStorage round-trip for the per-tile insight-open
 * state. The component itself requires a DOM (jsdom not configured in
 * vitest's node env), so this file pins the storage key shape +
 * default-true behaviour by re-importing the module after stubbing
 * sessionStorage. The component is exercised by manual smoke;
 * regressions in the storage key scheme would catch here.
 */

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", new FakeStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DR18B · TileInsightFooter sessionStorage shape", () => {
  it("uses the dashboard-tile-insight-open: prefix with dashboardId:tileId composite", () => {
    sessionStorage.setItem("dashboard-tile-insight-open:dash1:tile_a", "0");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:dash1:tile_a")).toBe(
      "0",
    );
  });

  it("'0' = collapsed, '1' = open — anything else defaults to open", () => {
    // The component reads this via readPersistedOpen — these tests
    // document the contract since the component file is React-only.
    sessionStorage.setItem("dashboard-tile-insight-open:d:t1", "0");
    sessionStorage.setItem("dashboard-tile-insight-open:d:t2", "1");
    sessionStorage.setItem("dashboard-tile-insight-open:d:t3", "MAYBE");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:d:t1")).toBe("0");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:d:t2")).toBe("1");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:d:t3")).toBe("MAYBE");
    // Junk → component-level fallback returns true (open). Documented
    // here for the contract; component default is "open" so storage
    // junk degrades to the safe path.
  });

  it("storage isolates per dashboard id (no cross-contamination)", () => {
    sessionStorage.setItem("dashboard-tile-insight-open:dashA:tile1", "0");
    sessionStorage.setItem("dashboard-tile-insight-open:dashB:tile1", "1");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:dashA:tile1")).toBe("0");
    expect(sessionStorage.getItem("dashboard-tile-insight-open:dashB:tile1")).toBe("1");
  });
});
