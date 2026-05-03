import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Context,
  type ReactNode,
} from 'react';
import type { ChatPivotNavEntry } from '@/pages/Home/lib/chatPivotNav';

export type { ChatPivotNavEntry };

type ScrollRequest = { id: string; nonce: number };

type PivotMutationHandlers = {
  /** Toggle pinned state for the message at this ms-epoch timestamp. */
  togglePivotPin: (messageTimestamp: number) => void;
  /**
   * Set or clear the user's custom name. Pass `null` (or empty string) to
   * clear back to the auto-derived name.
   */
  renamePivot: (messageTimestamp: number, name: string | null) => void;
};

type ChatSidebarNavContextValue = {
  pivotEntries: ChatPivotNavEntry[];
  setPivotEntries: (entries: ChatPivotNavEntry[]) => void;
  scrollRequest: ScrollRequest | null;
  requestPivotScroll: (id: string) => void;
  clearPivotScrollRequest: () => void;
  /** Home.tsx registers concrete handlers via `setPivotMutationHandlers`. */
  togglePivotPin: PivotMutationHandlers['togglePivotPin'];
  renamePivot: PivotMutationHandlers['renamePivot'];
  setPivotMutationHandlers: (handlers: PivotMutationHandlers | null) => void;
};

// HMR-resilient singleton — see DashboardContext.tsx for rationale.
const CHATSIDEBAR_CONTEXT_KEY = "__MARICO_CHATSIDEBAR_CONTEXT_V1__";
const ChatSidebarNavContext: Context<ChatSidebarNavContextValue | null> =
  ((globalThis as Record<string, unknown>)[CHATSIDEBAR_CONTEXT_KEY] as
    | Context<ChatSidebarNavContextValue | null>
    | undefined) ??
  ((globalThis as Record<string, unknown>)[CHATSIDEBAR_CONTEXT_KEY] = createContext<
    ChatSidebarNavContextValue | null
  >(null)) as Context<ChatSidebarNavContextValue | null>;

const NOOP_HANDLERS: PivotMutationHandlers = {
  togglePivotPin: () => {},
  renamePivot: () => {},
};

export function ChatSidebarNavProvider({ children }: { children: ReactNode }) {
  const [pivotEntries, setPivotEntries] = useState<ChatPivotNavEntry[]>([]);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(
    null
  );
  // Handlers come from Home.tsx (which holds the messages + session id).
  // Stored in a ref so registering them doesn't re-render every consumer.
  const handlersRef = useRef<PivotMutationHandlers>(NOOP_HANDLERS);

  const requestPivotScroll = useCallback((id: string) => {
    setScrollRequest((prev) => ({
      id,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  const clearPivotScrollRequest = useCallback(() => {
    setScrollRequest(null);
  }, []);

  const setPivotMutationHandlers = useCallback(
    (handlers: PivotMutationHandlers | null) => {
      handlersRef.current = handlers ?? NOOP_HANDLERS;
    },
    []
  );

  const togglePivotPin = useCallback((messageTimestamp: number) => {
    handlersRef.current.togglePivotPin(messageTimestamp);
  }, []);

  const renamePivot = useCallback(
    (messageTimestamp: number, name: string | null) => {
      handlersRef.current.renamePivot(messageTimestamp, name);
    },
    []
  );

  const value = useMemo(
    () => ({
      pivotEntries,
      setPivotEntries,
      scrollRequest,
      requestPivotScroll,
      clearPivotScrollRequest,
      togglePivotPin,
      renamePivot,
      setPivotMutationHandlers,
    }),
    [
      pivotEntries,
      scrollRequest,
      requestPivotScroll,
      clearPivotScrollRequest,
      togglePivotPin,
      renamePivot,
      setPivotMutationHandlers,
    ]
  );

  return (
    <ChatSidebarNavContext.Provider value={value}>
      {children}
    </ChatSidebarNavContext.Provider>
  );
}

export function useChatSidebarNav(): ChatSidebarNavContextValue {
  const ctx = useContext(ChatSidebarNavContext);
  if (!ctx) {
    throw new Error('useChatSidebarNav must be used within ChatSidebarNavProvider');
  }
  return ctx;
}
