/**
 * useSuperadmin · TanStack-Query-cached check for whether the current user is
 * one of the two hardcoded shadow-viewer emails. Used by Layout.tsx to gate
 * the "Admin View" navbar item, and by superadmin pages to redirect non-
 * superadmins to /analysis (defence in depth — URL guessing should not work).
 *
 * Cached for the session — superadmin status doesn't change without a
 * deploy. Refetch on mount/focus is wasteful, hence the long staleTime.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchSuperadminMe, type SuperadminMeResponse } from "@/lib/api/superadmin";

const QUERY_KEY = ["superadmin", "me"] as const;

export function useSuperadmin(): {
  isSuperadmin: boolean;
  isLoading: boolean;
  email: string | null;
} {
  const { data, isLoading } = useQuery<SuperadminMeResponse>({
    queryKey: QUERY_KEY,
    queryFn: fetchSuperadminMe,
    staleTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  return {
    isSuperadmin: data?.isSuperadmin ?? false,
    isLoading,
    email: data?.email ?? null,
  };
}
