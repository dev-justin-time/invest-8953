import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider } from "./session";
import { log } from "../lib/log";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // Business rejections (4xx) are final; transient server/network faults get two quiet retries.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || status >= 500;
        if (retryable && failureCount < 2) log.warn("query", `Transient failure, retrying (${failureCount + 1}/2)`, status ?? "network");
        return retryable && failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(400 * 2 ** attempt, 2000),
    },
  },
  mutationCache: new MutationCache({
    onMutate: (_variables, mutation) => { log.decide("mutation", "Requested", mutation.options.mutationKey); },
    onSuccess: (_data, _variables, _context, mutation) => { log.decide("mutation", "Completed", mutation.options.mutationKey); },
    onError: (_error, _variables, _context, mutation) => { log.warn("mutation", "Rejected; see the inline explanation", mutation.options.mutationKey); },
  }),
});

interface ProviderProps {
  children: React.ReactNode;
}

export function Provider({ children }: ProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
