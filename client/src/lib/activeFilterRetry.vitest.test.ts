/**
 * Wave E4 · Pins the stale-filter-version retry contract.
 *
 * The wrapper exists so client call sites (pivot queries, chart data
 * loads) can opt into automatic recovery if the server starts returning
 * `code: "active_filter_version_mismatch"`. Today the server doesn't
 * emit that — the wrapper is unused in production — but the contract
 * is verifiable independently.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  isStaleActiveFilterError,
  withActiveFilterRetry,
} from "./activeFilterRetry";

// Mock the sessions API so we don't hit a real fetch.
vi.mock("./api/sessions", () => ({
  sessionsApi: {
    getActiveFilter: vi.fn(),
  },
}));

let getActiveFilterMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mod = await import("./api/sessions");
  getActiveFilterMock = mod.sessionsApi.getActiveFilter as ReturnType<typeof vi.fn>;
  getActiveFilterMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Wave E4 · isStaleActiveFilterError", () => {
  test("recognises the literal code string in Error.message", () => {
    expect(
      isStaleActiveFilterError(new Error("400 active_filter_version_mismatch"))
    ).toBe(true);
  });

  test("recognises (err as any).code", () => {
    expect(
      isStaleActiveFilterError({ code: "active_filter_version_mismatch" })
    ).toBe(true);
  });

  test("ignores unrelated errors", () => {
    expect(isStaleActiveFilterError(new Error("network failed"))).toBe(false);
    expect(isStaleActiveFilterError({ code: "rate_limited" })).toBe(false);
    expect(isStaleActiveFilterError(null)).toBe(false);
    expect(isStaleActiveFilterError(undefined)).toBe(false);
    expect(isStaleActiveFilterError("plain string error")).toBe(false);
  });

  test("recognises the code embedded in a plain-string error message", () => {
    expect(isStaleActiveFilterError("Got 400 — active_filter_version_mismatch.")).toBe(true);
  });
});

describe("Wave E4 · withActiveFilterRetry — happy path", () => {
  test("first call succeeds → no retry, no refetch", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withActiveFilterRetry("sess", fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getActiveFilterMock).not.toHaveBeenCalled();
  });

  test("non-stale error propagates without retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(withActiveFilterRetry("sess", fn)).rejects.toThrow(
      "network down"
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getActiveFilterMock).not.toHaveBeenCalled();
  });
});

describe("Wave E4 · withActiveFilterRetry — retry on stale-filter error", () => {
  test("stale error → refetch active filter → retry fn → return result", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("400 active_filter_version_mismatch");
      }
      return "ok-after-retry";
    });
    const refreshedFilter = {
      ok: true,
      activeFilter: { conditions: [], version: 5, updatedAt: Date.now() },
      totalRows: 100,
      filteredRows: 100,
      preview: [],
      effectiveConditionCount: 0,
    };
    getActiveFilterMock.mockResolvedValue(refreshedFilter);

    const onFilterRefetched = vi.fn();
    const onRetryTriggered = vi.fn();
    const result = await withActiveFilterRetry("sess_42", fn, {
      onFilterRefetched,
      onRetryTriggered,
    });

    expect(result).toBe("ok-after-retry");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getActiveFilterMock).toHaveBeenCalledTimes(1);
    expect(getActiveFilterMock).toHaveBeenCalledWith("sess_42");
    expect(onFilterRefetched).toHaveBeenCalledWith(refreshedFilter);
    expect(onRetryTriggered).toHaveBeenCalledTimes(1);
  });

  test("retry attempt fails → second error propagates", async () => {
    let attempts = 0;
    const fn = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("active_filter_version_mismatch");
      }
      throw new Error("retry also failed");
    });
    getActiveFilterMock.mockResolvedValue({ activeFilter: null });

    await expect(withActiveFilterRetry("sess", fn)).rejects.toThrow(
      "retry also failed"
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("refetch itself fails → original stale error rethrown (NOT the refetch error)", async () => {
    const fn = vi.fn().mockRejectedValue(
      new Error("active_filter_version_mismatch — stale")
    );
    getActiveFilterMock.mockRejectedValue(new Error("network down on refetch"));

    await expect(withActiveFilterRetry("sess", fn)).rejects.toThrow(
      /stale/
    );
    expect(fn).toHaveBeenCalledTimes(1); // never got to retry
  });

  test("only retries ONCE — repeated stale errors do not loop", async () => {
    const fn = vi.fn().mockRejectedValue(
      new Error("active_filter_version_mismatch")
    );
    getActiveFilterMock.mockResolvedValue({ activeFilter: null });

    // Both passes fail with stale; the wrapper retries exactly once,
    // so the SECOND failure surfaces as-is — no third attempt.
    await expect(withActiveFilterRetry("sess", fn)).rejects.toThrow(
      "active_filter_version_mismatch"
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getActiveFilterMock).toHaveBeenCalledTimes(1);
  });
});
