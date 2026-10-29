/**
 * Small JSON responders shared by the API routes.
 *
 * TanStack Start only registers the HTTP methods a route declares, and an
 * unhandled method falls through to the page router — which answered a POST to
 * an API path with the HTML application shell. These helpers give clients a
 * correct status and content type instead.
 */

export function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return jsonResponse(
    {
      status: "error",
      code: "method_not_allowed",
      message: `This endpoint accepts ${allowed.join(", ")}.`,
    },
    405,
    { allow: allowed.join(", ") },
  );
}

export function apiNotFound(): Response {
  return jsonResponse(
    { status: "error", code: "not_found", message: "This API endpoint does not exist." },
    404,
  );
}

/** Every method an API route does not implement should answer with 405. */
export function unsupportedMethods(allowed: readonly string[]): Record<string, () => Response> {
  const handlers: Record<string, () => Response> = {};
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
    if (allowed.includes(method)) continue;
    handlers[method] = () => methodNotAllowed(allowed);
  }
  return handlers;
}
