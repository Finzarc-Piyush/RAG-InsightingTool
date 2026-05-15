import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Wave DR1 · view/edit mode for the dashboard surface.
 *
 * `canEdit` (permission) and `mode` (intent) are orthogonal:
 *   - `canEdit` is derived from ownership / shared permission and
 *     decides whether the toggle is *available*.
 *   - `mode` is the user's *current* intent — Edit reveals authoring
 *     affordances (drag handles, resize, delete, edit pencils);
 *     View hides them so a finished dashboard reads as a calm, dense
 *     presentation surface.
 *
 * Filters are intentionally *not* gated on mode (filtering is a
 * consumption activity, not an authoring one).
 *
 * For users without `canEdit` the toggle is locked to View and the
 * UI is expected to omit the toggle entirely (a disabled toggle
 * invites "why can't I click this?").
 *
 * Mode persists per dashboard in `sessionStorage` so a refresh
 * doesn't drop edit mode mid-task.
 */

export type DashboardEditMode = "view" | "edit";

const SESSION_PREFIX = "dashboard-edit-mode:";

export function readPersistedMode(
  dashboardId: string,
): DashboardEditMode | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`${SESSION_PREFIX}${dashboardId}`);
    if (raw === "edit") return "edit";
    if (raw === "view") return "view";
    return null;
  } catch {
    return null;
  }
}

export function writePersistedMode(
  dashboardId: string,
  mode: DashboardEditMode,
): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`${SESSION_PREFIX}${dashboardId}`, mode);
  } catch {
    // Quota / private mode — ignore. Mode lives in memory for the session.
  }
}

/**
 * Mirrors `isEditableTarget` in `useLayoutHistory.ts`. Used to gate the
 * `e` keyboard shortcut so it doesn't fire while the user is renaming
 * a sheet, editing an insight, or typing in any input.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

interface DashboardEditModeContextValue {
  mode: DashboardEditMode;
  setMode: (mode: DashboardEditMode) => void;
  toggle: () => void;
  canToggle: boolean;
}

const Context = createContext<DashboardEditModeContextValue | undefined>(
  undefined,
);

interface ProviderProps {
  dashboardId: string;
  canEdit: boolean;
  children: ReactNode;
}

export function DashboardEditModeProvider({
  dashboardId,
  canEdit,
  children,
}: ProviderProps) {
  // DR18E · default to `edit` for users with edit permission when no
  // explicit preference has been recorded. Pre-DR18E the default was
  // `view` for everyone, so a freshly-created dashboard opened with
  // drag handles, resize handles, and delete buttons all hidden — the
  // user had to discover the "Edit" toggle in the header to rearrange
  // tiles. Owners are almost always still authoring at that moment.
  // Viewers (canEdit=false) stay locked to `view`. Once the user
  // explicitly toggles to view, that choice persists via
  // `writePersistedMode` and is honoured on subsequent opens.
  const initialDefault = canEdit ? "edit" : "view";
  const [mode, setModeState] = useState<DashboardEditMode>(() => {
    if (!canEdit) return "view";
    return readPersistedMode(dashboardId) ?? initialDefault;
  });

  // Permission revoked or dashboard switched — restore from storage / lock to view.
  useEffect(() => {
    if (!canEdit) {
      setModeState("view");
      return;
    }
    setModeState(readPersistedMode(dashboardId) ?? initialDefault);
  }, [dashboardId, canEdit, initialDefault]);

  const setMode = useCallback(
    (next: DashboardEditMode) => {
      if (!canEdit && next === "edit") return;
      setModeState(next);
      writePersistedMode(dashboardId, next);
    },
    [canEdit, dashboardId],
  );

  const toggle = useCallback(() => {
    setMode(mode === "edit" ? "view" : "edit");
  }, [mode, setMode]);

  // `e` toggles edit mode. Gated on (a) no modifier (so Cmd+E etc. pass
  // through to the browser / OS), (b) target not an editable element.
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== "e") return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, toggle]);

  const value: DashboardEditModeContextValue = {
    mode,
    setMode,
    toggle,
    canToggle: canEdit,
  };

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/**
 * Returns the current mode + setters. Outside a Provider it returns a
 * safe default (view, no-op setters, canToggle=false) so consumers
 * mounted without the provider don't crash — useful for the chat
 * preview surface that reuses dashboard tile components.
 */
export function useDashboardEditMode(): DashboardEditModeContextValue {
  const ctx = useContext(Context);
  if (!ctx) {
    return {
      mode: "view",
      setMode: () => {},
      toggle: () => {},
      canToggle: false,
    };
  }
  return ctx;
}
