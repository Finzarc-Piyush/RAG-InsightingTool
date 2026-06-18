import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useRotatingMessage } from "./useRotatingMessage";

describe("useRotatingMessage", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("returns the first line immediately", () => {
    const { result } = renderHook(() => useRotatingMessage(["a", "b", "c"]));
    expect(result.current).toBe("a");
  });

  test("advances every intervalMs and wraps modulo length", () => {
    const { result } = renderHook(() =>
      useRotatingMessage(["a", "b", "c"], { intervalMs: 1000 })
    );
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("b");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("c");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("a");
  });

  test("honours a startIndex offset", () => {
    const { result } = renderHook(() =>
      useRotatingMessage(["a", "b", "c"], { intervalMs: 1000, startIndex: 1 })
    );
    expect(result.current).toBe("b");
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe("c");
  });

  test("does not advance while disabled", () => {
    const { result } = renderHook(() =>
      useRotatingMessage(["a", "b", "c"], { intervalMs: 1000, enabled: false })
    );
    expect(result.current).toBe("a");
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe("a");
  });

  test("is safe for empty and single-line banks", () => {
    const empty = renderHook(() => useRotatingMessage([], { intervalMs: 1000 }));
    expect(empty.result.current).toBe("");

    const single = renderHook(() =>
      useRotatingMessage(["only"], { intervalMs: 1000 })
    );
    expect(single.result.current).toBe("only");
    act(() => vi.advanceTimersByTime(3000));
    expect(single.result.current).toBe("only");
  });
});
