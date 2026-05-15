/**
 * useSuperadmin · TanStack-Query-cached check for whether the current user is
 * one of the hardcoded admin emails (Wave AD2 reduced the list to just
 * `piyush@finzarc.com`). Used by Layout.tsx to gate the "Admin View" navbar
 * item and by admin pages to gate their content.
 *
 * Wave AD7 follow-up · refetch on mount + 60s staleTime so a stale `false`
 * from before AD2 shipped (or any transient network blip) can't trap the
 * user out of the admin surface for an hour. Status is cheap (one tiny
 * Cosmos-free endpoint) so refetching on every page mount is fine.
 *
 * `hasResolved` lets callers distinguish "we know the answer is false" from
 * "we haven't received a response yet" so they can avoid redirecting on
 * the brief loading flash.
 */

import { useQuery } from "@tanstack/react-query";
import { fetchSuperadminMe, type SuperadminMeResponse } from "@/lib/api/superadmin";

const QUERY_KEY = ["superadmin", "me"] as const;

export function useSuperadmin(): {
  isSuperadmin: boolean;
  isLoading: boolean;
  hasResolved: boolean;
  email: string | null;
} {
  const { data, isLoading, isSuccess } = useQuery<SuperadminMeResponse>({
    queryKey: QUERY_KEY,
    queryFn: fetchSuperadminMe,
    staleTime: 60 * 1000, // 60s
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  return {
    isSuperadmin: data?.isSuperadmin ?? false,
    isLoading,
    hasResolved: isSuccess,
    email: data?.email ?? null,
  };
}
