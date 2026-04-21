import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { apiRequest } from "./api";

// Re-export the apiRequest function for backward compatibility
export { apiRequest };

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    try {
      return await apiRequest<T>({
        method: 'GET',
        route: queryKey.join("/") as string,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('401') && unauthorizedBehavior === "returnNull") {
        return null;
      }
      throw error;
    }
  };

// P-014: previous defaults (staleTime: Infinity, no retry, no refetchOnWindowFocus)
// meant users saw indefinitely-stale data and never recovered from transient
// failures. Sane defaults below; individual queries can still opt out.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
    },
    mutations: {
      retry: false,
    },
  },
});
