import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isEditableTarget,
  readPersistedMode,
  writePersistedMode,
} from "./DashboardEditModeContext";

/**
 * DR1 · pure-helper coverage for the edit-mode context.
 *
 * Vitest runs in node env (no jsdom) so the React provider is verified
 * by manual smoke + tsc; the deterministic helpers (sessionStorage
 * persistence, editable-target gate) are pinned here.
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
  // Stand up a fresh fake `sessionStorage` and a stand-in `HTMLElement`
  // so the helpers can run in node. Both are removed in `afterEach`.
  vi.stubGlobal("sessionStorage", new FakeStorage());

  class FakeHTMLElement {
    tagName = "DIV";
    isContentEditable = false;
  }
  vi.stubGlobal("HTMLElement", FakeHTMLElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readPersistedMode / writePersistedMode", () => {
  it("returns null when no value has been written", () => {
    expect(readPersistedMode("dash-1")).toBeNull();
  });

  it("round-trips edit / view values per dashboard id", () => {
    writePersistedMode("dash-1", "edit");
    writePersistedMode("dash-2", "view");
    expect(readPersistedMode("dash-1")).toBe("edit");
    expect(readPersistedMode("dash-2")).toBe("view");
  });

  it("ignores junk values (defends against external tampering)", () => {
    sessionStorage.setItem("dashboard-edit-mode:dash-x", "MAYBE");
    expect(readPersistedMode("dash-x")).toBeNull();
  });

  it("survives sessionStorage throwing (private-mode / quota)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", throwing);
    expect(readPersistedMode("dash-x")).toBeNull();
    expect(() => writePersistedMode("dash-x", "edit")).not.toThrow();
  });

  it("returns null in non-browser env", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(readPersistedMode("dash-1")).toBeNull();
    expect(() => writePersistedMode("dash-1", "edit")).not.toThrow();
  });
});

describe("isEditableTarget — keyboard shortcut gate", () => {
  function makeEl(props: {
    tagName?: string;
    isContentEditable?: boolean;
  }): HTMLElement {
    const el = new (globalThis as unknown as { HTMLElement: new () => HTMLElement }).HTMLElement();
    Object.assign(el, {
      tagName: props.tagName ?? "DIV",
      isContentEditable: props.isContentEditable ?? false,
    });
    return el;
  }

  it("returns false for non-element targets", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({} as EventTarget)).toBe(false);
  });

  it("returns true for INPUT / TEXTAREA / SELECT", () => {
    expect(isEditableTarget(makeEl({ tagName: "INPUT" }))).toBe(true);
    expect(isEditableTarget(makeEl({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableTarget(makeEl({ tagName: "SELECT" }))).toBe(true);
  });

  it("returns true for contenteditable elements", () => {
    expect(isEditableTarget(makeEl({ tagName: "DIV", isContentEditable: true }))).toBe(
      true,
    );
  });

  it("returns false for ordinary clickable elements", () => {
    expect(isEditableTarget(makeEl({ tagName: "BUTTON" }))).toBe(false);
    expect(isEditableTarget(makeEl({ tagName: "DIV" }))).toBe(false);
    expect(isEditableTarget(makeEl({ tagName: "A" }))).toBe(false);
  });

  it("returns false when HTMLElement is unavailable (SSR-style env)", () => {
    // Build the candidate before nuking the constructor; the helper guards
    // both `typeof HTMLElement === 'undefined'` and the `instanceof` check.
    const candidate = makeEl({ tagName: "INPUT" });
    vi.stubGlobal("HTMLElement", undefined);
    expect(isEditableTarget(candidate)).toBe(false);
  });
});
