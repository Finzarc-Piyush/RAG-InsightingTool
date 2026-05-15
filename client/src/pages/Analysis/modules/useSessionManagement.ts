import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { sessionsApi } from '@/lib/api';
import { getUserEmail } from '@/utils/userStorage';
import { Session, SessionsResponse } from '../types';

interface UseSessionManagementProps {
  onLoadSession?: (sessionId: string, sessionData: any) => void;
  onNavigate?: (page: 'home' | 'dashboard' | 'analysis') => void;
  refetch: () => void;
}

/**
 * Custom hook for managing session operations
 * Handles loading, deleting, editing, and sharing sessions
 */
export const useSessionManagement = ({
  onLoadSession,
  onNavigate,
  refetch,
}: UseSessionManagementProps) => {
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [sessionToDelete, setSessionToDelete] = useState<Session | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [sessionToEdit, setSessionToEdit] = useState<Session | null>(null);
  const [editFileName, setEditFileName] = useState('');
  const [isUpdating, setIsUpdating] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sessionToShare, setSessionToShare] = useState<Session | null>(null);

  const { toast } = useToast();
  const userEmail = getUserEmail();
  const queryClient = useQueryClient();

  const handleSessionClick = useCallback(
    async (session: Session) => {
      if (loadingSessionId) return;

      setLoadingSessionId(session.sessionId);

      try {
        console.log('🔍 Loading session details for:', session.sessionId);
        const sessionDetails = await sessionsApi.getSessionDetails(session.sessionId);
        console.log('✅ Session details loaded:', sessionDetails);

        if (onLoadSession) {
          onLoadSession(session.sessionId, sessionDetails);
          toast({
            title: 'Session Loaded',
            description: `Analysis for ${session.fileName} is now active`,
          });
        } else if (onNavigate) {
          onNavigate('home');
          toast({
            title: 'Session Selected',
            description: `Switched to analysis for ${session.fileName}`,
          });
        }
      } catch (error) {
        console.error('❌ Failed to load session:', error);
        toast({
          title: 'Error Loading Session',
          description: 'Failed to load session details. Please try again.',
          variant: 'destructive',
        });
      } finally {
        setLoadingSessionId(null);
      }
    },
    [loadingSessionId, onLoadSession, onNavigate, toast]
  );

  const handleDeleteClick = useCallback((e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setSessionToDelete(session);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!sessionToDelete) return;

    setIsDeleting(true);
    try {
      await sessionsApi.deleteSession(sessionToDelete.sessionId);

      toast({
        title: 'Session Deleted',
        description: `Analysis session for ${sessionToDelete.fileName} has been deleted.`,
      });

      queryClient.invalidateQueries({ queryKey: ['sessions', userEmail] });
      refetch();

      setDeleteDialogOpen(false);
      setSessionToDelete(null);
    } catch (error) {
      console.error('❌ Failed to delete session:', error);
      toast({
        title: 'Error Deleting Session',
        description:
          error instanceof Error ? error.message : 'Failed to delete session. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  }, [sessionToDelete, toast, queryClient, userEmail, refetch]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false);
    setSessionToDelete(null);
  }, []);

  const handleEditClick = useCallback((e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setSessionToEdit(session);
    setEditFileName(session.fileName);
    setEditDialogOpen(true);
  }, []);

  const handleEditConfirm = useCallback(async () => {
    if (!sessionToEdit || !editFileName.trim()) return;

    setIsUpdating(true);
    const newName = editFileName.trim();
    const targetId = sessionToEdit.sessionId;
    const queryKey = ['sessions', userEmail] as const;

    // Optimistic cache write so the new name lands immediately in every
    // surface keyed off ['sessions', userEmail] (Analysis page list AND the
    // sidebar in Layout.tsx). The pre-fix path only invalidated, so the
    // user saw a stale label until the refetch resolved.
    const previous = queryClient.getQueryData<SessionsResponse>(queryKey);
    queryClient.setQueryData<SessionsResponse>(queryKey, (old) =>
      old
        ? {
            ...old,
            sessions: old.sessions.map((s) =>
              s.sessionId === targetId ? { ...s, fileName: newName } : s,
            ),
          }
        : old,
    );

    try {
      await sessionsApi.updateSessionName(targetId, newName);

      toast({
        title: 'Analysis Name Updated',
        description: `Analysis name has been updated to "${newName}".`,
      });

      queryClient.invalidateQueries({ queryKey });
      refetch();

      setEditDialogOpen(false);
      setSessionToEdit(null);
      setEditFileName('');
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      console.error('❌ Failed to update session name:', error);
      toast({
        title: 'Error Updating Name',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to update analysis name. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsUpdating(false);
    }
  }, [sessionToEdit, editFileName, toast, queryClient, userEmail, refetch]);

  const handleEditCancel = useCallback(() => {
    setEditDialogOpen(false);
    setSessionToEdit(null);
    setEditFileName('');
  }, []);

  const handleShareClick = useCallback((e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setSessionToShare(session);
    setShareDialogOpen(true);
  }, []);

  return {
    // Loading state
    loadingSessionId,

    // Delete dialog state
    deleteDialogOpen,
    setDeleteDialogOpen,
    sessionToDelete,
    isDeleting,
    handleDeleteClick,
    handleDeleteConfirm,
    handleDeleteCancel,

    // Edit dialog state
    editDialogOpen,
    setEditDialogOpen,
    sessionToEdit,
    editFileName,
    setEditFileName,
    isUpdating,
    handleEditClick,
    handleEditConfirm,
    handleEditCancel,

    // Share dialog state
    shareDialogOpen,
    setShareDialogOpen,
    sessionToShare,
    setSessionToShare,
    handleShareClick,

    // Session operations
    handleSessionClick,
  };
};

