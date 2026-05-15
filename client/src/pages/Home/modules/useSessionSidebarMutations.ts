import { useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import { getUserEmail } from '@/utils/userStorage';
import { useToast } from '@/hooks/use-toast';
import type { Session, SessionsResponse } from '@/pages/Analysis/types';

type Patch = Partial<Pick<Session, 'fileName' | 'pinned' | 'pinnedAt'>>;

type Variables = { sessionId: string; patch: Patch };

type RollbackContext = { previous: SessionsResponse | undefined };

const applyPatch = (
  data: SessionsResponse | undefined,
  sessionId: string,
  patch: Patch,
): SessionsResponse | undefined => {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((s) =>
      s.sessionId === sessionId ? { ...s, ...patch } : s,
    ),
  };
};

/**
 * Per-session sidebar mutations with optimistic updates against the
 * `['sessions', userEmail]` TanStack cache. Optimistic updates land
 * immediately so the user sees the new label / pin state before the
 * server round-trip; on error we roll back to the snapshot taken in
 * `onMutate`. This is the fix for "rename/pin doesn't show up" — earlier
 * attempts only invalidated, which left the user staring at stale UI
 * until the refetch landed.
 */
export function useSessionSidebarMutations() {
  const queryClient = useQueryClient();
  const userEmail = getUserEmail();
  const queryKey = ['sessions', userEmail] as const;
  const { toast } = useToast();

  const renameMutation = useMutation<unknown, Error, Variables, RollbackContext>({
    mutationFn: ({ sessionId, patch }) =>
      sessionsApi.updateSessionName(sessionId, patch.fileName ?? ''),
    onMutate: async ({ sessionId, patch }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SessionsResponse>(queryKey);
      queryClient.setQueryData<SessionsResponse>(queryKey, (old) =>
        applyPatch(old, sessionId, patch),
      );
      return { previous };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      toast({
        title: 'Rename failed',
        description: error?.message ?? 'Could not rename session.',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      // Background invalidate to settle any server-derived fields.
      queryClient.invalidateQueries({ queryKey });
    },
  });

  const pinMutation = useMutation<unknown, Error, Variables, RollbackContext>({
    mutationFn: ({ sessionId, patch }) =>
      sessionsApi.updateSessionPinned(sessionId, Boolean(patch.pinned)),
    onMutate: async ({ sessionId, patch }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<SessionsResponse>(queryKey);
      queryClient.setQueryData<SessionsResponse>(queryKey, (old) =>
        applyPatch(old, sessionId, {
          pinned: patch.pinned,
          pinnedAt: patch.pinned ? Date.now() : undefined,
        }),
      );
      return { previous };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
      toast({
        title: 'Pin failed',
        description: error?.message ?? 'Could not update pin.',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    renameSession: (sessionId: string, fileName: string) =>
      renameMutation.mutate({ sessionId, patch: { fileName } }),
    toggleSessionPin: (sessionId: string, pinned: boolean) =>
      pinMutation.mutate({ sessionId, patch: { pinned } }),
    isRenaming: renameMutation.isPending,
    isPinning: pinMutation.isPending,
  };
}
