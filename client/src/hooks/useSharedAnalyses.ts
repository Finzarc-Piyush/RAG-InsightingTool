import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acquireIdTokenForApi } from "@/auth/msalToken";
import {
  AnalysisSessionSummary,
  SharedAnalysesResponse,
  SharedAnalysisInvite,
} from "@/shared/schema";
import { sharedAnalysesApi } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { getUserEmail } from "@/utils/userStorage";
import { API_BASE_URL } from "@/lib/config";
import { useEventStream } from "@/hooks/useEventStream";

interface SharedAnalysesHookState {
  pending: SharedAnalysisInvite[];
  accepted: SharedAnalysisInvite[];
  loading: boolean;
  error: string | null;
}

const initialState: SharedAnalysesHookState = {
  pending: [],
  accepted: [],
  loading: true,
  error: null,
};

export const useSharedAnalyses = () => {
  const [{ pending, accepted, loading, error }, setState] =
    useState<SharedAnalysesHookState>(initialState);
  const [isMutating, setIsMutating] = useState(false);
  const { toast } = useToast();
  const fallbackIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const loadSharedAnalyses = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const response = await sharedAnalysesApi.getIncoming();
      setState({
        pending: response.pending,
        accepted: response.accepted,
        loading: false,
        error: null,
      });
    } catch (err) {
      console.error("Failed to load shared analyses:", err);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Unable to fetch shared analyses.",
      }));
    }
  }, []);

  const stopFallbackPolling = useCallback(() => {
    if (fallbackIntervalRef.current) {
      clearInterval(fallbackIntervalRef.current);
      fallbackIntervalRef.current = null;
    }
  }, []);

  const startFallbackPolling = useCallback(() => {
    console.error("❌ Max reconnect attempts reached, falling back to polling");
    setState((prev) => ({
      ...prev,
      error: "Connection lost. Falling back to polling.",
    }));
    loadSharedAnalyses();
    stopFallbackPolling();
    fallbackIntervalRef.current = setInterval(loadSharedAnalyses, 10000);
  }, [loadSharedAnalyses, stopFallbackPolling]);

  useEffect(() => {
    const email = getUserEmail();
    if (!email) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: "User email not found",
      }));
      return;
    }
    setUserEmail(email);
    return () => {
      stopFallbackPolling();
    };
  }, [stopFallbackPolling]);

  useEffect(() => {
    if (userEmail) {
      loadSharedAnalyses();
    }
  }, [loadSharedAnalyses, userEmail]);

  const [sseUrl, setSseUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!userEmail) {
      setSseUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const token = await acquireIdTokenForApi();
      if (cancelled) return;
      const params = new URLSearchParams();
      if (token) {
        params.set("access_token", token);
      }
      setSseUrl(
        `${API_BASE_URL}/api/shared-analyses/incoming/stream?${params.toString()}`
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [userEmail]);

  const handleUpdateEvent = useCallback((event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data) as SharedAnalysesResponse;
      console.log("📥 Shared analyses update received:", data);
      setState({
        pending: data.pending,
        accepted: data.accepted,
        loading: false,
        error: null,
      });
    } catch (err) {
      console.error("Failed to parse SSE update data:", err);
      setState((prev) => ({
        ...prev,
        error: "Failed to parse update data",
      }));
    }
  }, []);

  const handleMessageEvent = useCallback((event: MessageEvent) => {
    console.log("📨 SSE message received:", event.data);
  }, []);

  const streamHandlers = useMemo(
    () => ({
      update: handleUpdateEvent,
      message: handleMessageEvent,
    }),
    [handleMessageEvent, handleUpdateEvent]
  );

  const handleStreamError = useCallback((event: Event) => {
    console.error("❌ SSE connection error:", event);
    setState((prev) => ({
      ...prev,
      error: "Connection error",
    }));
  }, []);

  const handleStreamOpen = useCallback(() => {
    console.log("✅ SSE connection opened for shared analyses");
    stopFallbackPolling();
    setState((prev) => ({ ...prev, loading: false, error: null }));
  }, [stopFallbackPolling]);

  useEventStream({
    url: sseUrl,
    eventHandlers: streamHandlers,
    onOpen: handleStreamOpen,
    onError: handleStreamError,
    onFallback: startFallbackPolling,
  });

  const acceptInvite = useCallback(
    async (inviteId: string): Promise<AnalysisSessionSummary | null> => {
      setIsMutating(true);
      try {
        const { invite, acceptedSession } = await sharedAnalysesApi.accept(inviteId);
        setState((prev) => ({
          ...prev,
          pending: prev.pending.filter((item) => item.id !== inviteId),
          accepted: [invite, ...prev.accepted.filter((item) => item.id !== inviteId)],
        }));
        toast({
          title: "Joined analysis workspace",
          description: "You're now collaborating on the original analysis.",
        });
        return acceptedSession;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unable to accept shared analysis.";
        toast({
          title: "Failed to accept analysis",
          description: message,
          variant: "destructive",
        });
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [toast]
  );

  const declineInvite = useCallback(
    async (inviteId: string) => {
      setIsMutating(true);
      try {
        await sharedAnalysesApi.decline(inviteId);
        setState((prev) => ({
          ...prev,
          pending: prev.pending.filter((item) => item.id !== inviteId),
        }));
        toast({
          title: "Invite declined",
          description: "The shared analysis invite has been removed.",
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unable to decline shared analysis.";
        toast({
          title: "Failed to decline",
          description: message,
          variant: "destructive",
        });
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [toast]
  );

  const shareAnalysis = useCallback(
    async (payload: { sessionId: string; targetEmail: string; note?: string }) => {
      setIsMutating(true);
      try {
        const result = await sharedAnalysesApi.share(payload);
        toast({
          title: "Analysis shared",
          description: `Invite sent to ${payload.targetEmail}.`,
        });
        return result.invite;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unable to share this analysis.";
        toast({
          title: "Share failed",
          description: message,
          variant: "destructive",
        });
        throw err;
      } finally {
        setIsMutating(false);
      }
    },
    [toast]
  );

  return {
    pending,
    accepted,
    loading,
    error,
    isMutating,
    refresh: loadSharedAnalyses,
    acceptInvite,
    declineInvite,
    shareAnalysis,
    hasSharedItems: useMemo(() => pending.length + accepted.length > 0, [pending, accepted]),
  };
};

