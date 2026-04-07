import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ChatPivotNavEntry = { id: string; label: string };

type ScrollRequest = { id: string; nonce: number };

type ChatSidebarNavContextValue = {
  pivotEntries: ChatPivotNavEntry[];
  setPivotEntries: (entries: ChatPivotNavEntry[]) => void;
  scrollRequest: ScrollRequest | null;
  requestPivotScroll: (id: string) => void;
  clearPivotScrollRequest: () => void;
};

const ChatSidebarNavContext = createContext<ChatSidebarNavContextValue | null>(
  null
);

export function ChatSidebarNavProvider({ children }: { children: ReactNode }) {
  const [pivotEntries, setPivotEntries] = useState<ChatPivotNavEntry[]>([]);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(
    null
  );

  const requestPivotScroll = useCallback((id: string) => {
    setScrollRequest((prev) => ({
      id,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
  }, []);

  const clearPivotScrollRequest = useCallback(() => {
    setScrollRequest(null);
  }, []);

  const value = useMemo(
    () => ({
      pivotEntries,
      setPivotEntries,
      scrollRequest,
      requestPivotScroll,
      clearPivotScrollRequest,
    }),
    [
      pivotEntries,
      scrollRequest,
      requestPivotScroll,
      clearPivotScrollRequest,
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
