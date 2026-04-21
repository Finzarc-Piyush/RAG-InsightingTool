import { useCallback, useEffect, useRef, useState } from "react";
import type { Layouts } from "react-grid-layout";

/**
 * Dashboard UX polish · undo stack for grid layout changes.
 *
 * Holds a per-(dashboardId, sheetId) ring buffer of committed layouts.
 * Consumers push after every user-driven commit; a global Cmd/Ctrl+Z
 * listener pops the top and calls `onUndo` with the restored snapshot.
 *
 * Design notes:
 *  - Capacity default 20 — covers realistic undo sessions without
 *    eating memory for very large dashboards.
 *  - History is scoped by `${dashboardId}:${sheetId}`; switching sheets
 *    resets the stack so undo never cross-contaminates views.
 *  - Undo is suppressed when focus is inside an editable element
 *    (input, textarea, contenteditable) so it doesn't hijack the
 *    browser's native text-edit undo.
 *  - Reduced-motion users get the same snap-back behaviour — the hook
 *    never animates anything itself; it only hands the layout back to
 *    the consumer, which already has a non-animating setLayouts path.
 *  - Redo is intentionally out of scope. Real users don't often redo a
 *    layout change; the added state machinery would outweigh the value.
 */

export interface UseLayoutHistoryArgs {
  /** Scope key: layout snapshots are segregated by dashboard + active sheet. */
  dashboardId: string;
  sheetId?: string;
  /** Consumer callback — receive a previous snapshot and apply it. */
  onUndo: (previous: Layouts) => void;
  /** Optional: disable the hook entirely (e.g. read-only dashboards). */
  enabled?: boolean;
  /** Ring-buffer capacity. Defaults to 20. */
  capacity?: number;
}

export interface LayoutHistory {
  /** Record a committed layout. No-op when the snapshot is identical to the top. */
  push: (layouts: Layouts) => void;
  /** True when the stack has at least one predecessor to restore. */
  canUndo: boolean;
  /** Clear the stack (e.g. when a fresh dashboard loads). */
  reset: () => void;
}

function snapshotsEqual(a: Layouts, b: Layouts): boolean {
  // Stable-key stringify to avoid false positives from breakpoint order.
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? []) !== JSON.stringify(b[k] ?? [])) {
      return false;
    }
  }
  return true;
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useLayoutHistory(args: UseLayoutHistoryArgs): LayoutHistory {
  const { dashboardId, sheetId, onUndo, enabled = true, capacity = 20 } = args;

  // History is a ref so pushes don't re-render; `canUndo` is state-backed
  // so the caller can disable a visible undo button when empty.
  const historyRef = useRef<Layouts[]>([]);
  const scopeRef = useRef<string>(`${dashboardId}:${sheetId ?? ""}`);
  const [canUndo, setCanUndo] = useState(false);

  // Reset on scope change.
  useEffect(() => {
    const nextScope = `${dashboardId}:${sheetId ?? ""}`;
    if (scopeRef.current !== nextScope) {
      historyRef.current = [];
      scopeRef.current = nextScope;
      setCanUndo(false);
    }
  }, [dashboardId, sheetId]);

  const push = useCallback(
    (layouts: Layouts) => {
      if (!enabled) return;
      const stack = historyRef.current;
      const top = stack[stack.length - 1];
      if (top && snapshotsEqual(top, layouts)) return;
      stack.push(structuredClone(layouts));
      if (stack.length > capacity) {
        stack.splice(0, stack.length - capacity);
      }
      setCanUndo(stack.length > 1);
    },
    [enabled, capacity]
  );

  const reset = useCallback(() => {
    historyRef.current = [];
    setCanUndo(false);
  }, []);

  // Undo on Cmd+Z / Ctrl+Z (not Cmd+Shift+Z — that's redo territory).
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const isUndoCombo =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey;
      if (!isUndoCombo) return;
      if (isEditableTarget(e.target)) return;
      const stack = historyRef.current;
      if (stack.length < 2) return;
      // Pop the current committed state, then apply whatever sits on top.
      stack.pop();
      const previous = stack[stack.length - 1];
      if (!previous) {
        setCanUndo(false);
        return;
      }
      e.preventDefault();
      onUndo(structuredClone(previous));
      setCanUndo(stack.length > 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, onUndo]);

  return { push, canUndo, reset };
}
