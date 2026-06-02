/**
 * Wave-FA · Pins the full-mode ("entire dataset") fetch + mapping contract.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  mapFullRowsResponse,
  fetchFilteredFullRows,
} from "./filteredFullRows";
import type { ActiveFilterResponse } from "./api/sessions";

vi.mock("./api/sessions", () => ({
  sessionsApi: {
    getActiveFilterFull: vi.fn(),
  },
}));

let getActiveFilterFullMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mod = await import("./api/sessions");
  getActiveFilterFullMock = mod.sessionsApi.getActiveFilterFull as ReturnType<
    typeof vi.fn
  >;
  getActiveFilterFullMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseResponse = (
  over: Partial<ActiveFilterResponse> = {}
): ActiveFilterResponse => ({
  ok: true,
  activeFilter: null,
  totalRows: 0,
  filteredRows: 0,
  preview: [],
  effectiveConditionCount: 0,
  ...over,
});

describe("mapFullRowsResponse", () => {
  test("maps preview rows + truncation flag through", () => {
    const out = mapFullRowsResponse(
      baseResponse({ preview: [{ a: 1 }, { a: 2 }], previewTruncated: true })
    );
    expect(out.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(out.truncated).toBe(true);
  });

  test("defaults truncated to false when absent", () => {
    const out = mapFullRowsResponse(baseResponse({ preview: [{ a: 1 }] }));
    expect(out.truncated).toBe(false);
  });

  test("coerces a missing/invalid preview to an empty array", () => {
    const out = mapFullRowsResponse(
      baseResponse({ preview: undefined as unknown as Record<string, unknown>[] })
    );
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });
});

describe("fetchFilteredFullRows", () => {
  test("calls the full endpoint and returns the mapped result", async () => {
    getActiveFilterFullMock.mockResolvedValue(
      baseResponse({ preview: [{ x: "MARICO" }], previewTruncated: false })
    );
    const out = await fetchFilteredFullRows("sess_1");
    expect(getActiveFilterFullMock).toHaveBeenCalledTimes(1);
    expect(getActiveFilterFullMock).toHaveBeenCalledWith("sess_1");
    expect(out).toEqual({ rows: [{ x: "MARICO" }], truncated: false });
  });

  test("propagates fetch errors to the caller", async () => {
    getActiveFilterFullMock.mockRejectedValue(new Error("network down"));
    await expect(fetchFilteredFullRows("sess_1")).rejects.toThrow("network down");
  });
});
