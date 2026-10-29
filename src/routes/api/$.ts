import { createFileRoute } from "@tanstack/react-router";
import { apiNotFound } from "@/server/http/responses";

/**
 * Unknown API paths must not fall through to the application router: a client
 * expecting JSON would otherwise receive the HTML page shell with a 200.
 */
export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: () => apiNotFound(),
      POST: () => apiNotFound(),
      PUT: () => apiNotFound(),
      PATCH: () => apiNotFound(),
      DELETE: () => apiNotFound(),
    },
  },
});
