import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readPersistedChartTileViewMode,
  writePersistedChartTileViewMode,
} from "./useChartTileViewMode";

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

/**
 * DR18D · sessionStorage round-trip for the chart-tile view mode.
 * The React hook itself requires a DOM; these tests pin the storage
 * key shape and the default-to-chart contract.
 */
describe("DR18D · chart tile view mode persistence", () => {
  it("defaults to 'chart' when nothing is stored", () => {
    expect(readPersistedChartTileViewMode("dash", "tile_a")).toBe("chart");
  });

  it("round-trips 'pivot' / 'chart' via the storage helpers", () => {
    writePersistedChartTileViewMode("dash", "tile_a", "pivot");
    expect(readPersistedChartTileViewMode("dash", "tile_a")).toBe("pivot");
    writePersistedChartTileViewMode("dash", "tile_a", "chart");
    expect(readPersistedChartTileViewMode("dash", "tile_a")).toBe("chart");
  });

  it("isolates per (dashboardId, tileId) — no cross-talk between tiles", () => {
    writePersistedChartTileViewMode("dash1", "t1", "pivot");
    writePersistedChartTileViewMode("dash1", "t2", "chart");
    writePersistedChartTileViewMode("dash2", "t1", "chart");
    expect(readPersistedChartTileViewMode("dash1", "t1")).toBe("pivot");
    expect(readPersistedChartTileViewMode("dash1", "t2")).toBe("chart");
    expect(readPersistedChartTileViewMode("dash2", "t1")).toBe("chart");
  });

  it("treats unknown stored values as 'chart' (defensive default)", () => {
    sessionStorage.setItem(
      "dashboard-chart-tile-view-mode:dash:tile",
      "weird",
    );
    expect(readPersistedChartTileViewMode("dash", "tile")).toBe("chart");
  });

  it("survives a throwing sessionStorage (private mode)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", throwing);
    expect(readPersistedChartTileViewMode("d", "t")).toBe("chart");
    expect(() => writePersistedChartTileViewMode("d", "t", "pivot")).not.toThrow();
  });
});
