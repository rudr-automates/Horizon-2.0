import { createFileRoute } from "@tanstack/react-router";
import { getAiProviderStatus } from "@/server/ai/runtime.server";

/**
 * Non-secret readiness probe. It reports whether server-side credentials were
 * loaded, never their values, and never performs a billable provider call.
 */
export const Route = createFileRoute("/api/ai/health")({
  server: {
    handlers: {
      GET: async () => {
        const status = getAiProviderStatus();
        const configured = status.providers.filter((provider) => provider.configured);
        return Response.json(
          {
            status: configured.length ? "ready" : "unconfigured",
            providers: status.providers,
            embeddings: status.embeddings,
            paidFallback: false,
          },
          {
            headers: {
              "cache-control": "no-store",
            },
          },
        );
      },
    },
  },
});
