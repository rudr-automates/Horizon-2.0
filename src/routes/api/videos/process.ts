import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";
import { advanceIngestion, getIngestionStatus } from "@/server/ingestion/video-pipeline.server";
import { readJsonBody } from "@/server/storage/signed-upload.server";
import { unsupportedMethods } from "@/server/http/responses";

const noStore = { "cache-control": "no-store" };

function fail(status: number, code: string, message: string): Response {
  return Response.json({ status: "error", code, message }, { status, headers: noStore });
}

/**
 * Advances the universal video pipeline for one owned lesson.
 *
 * Each call performs a bounded amount of work (a few media chunks, one provider
 * poll, or the final indexing pass) so it is safe on a serverless runtime. The
 * browser polls while the returned state is `queued` or `processing`.
 */
export const Route = createFileRoute("/api/videos/process")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await authenticateApiUser(request);
        if (!user) return fail(401, "unauthorized", "Sign in to view processing status.");
        const lessonId = new URL(request.url).searchParams.get("lessonId")?.trim() ?? "";
        if (!lessonId) return fail(400, "invalid_request", "A lesson ID is required.");
        const ingestion = await getIngestionStatus({
          supabase: user.supabase,
          userId: user.userId,
          lessonId,
        });
        return Response.json({ status: "ok", ingestion }, { headers: noStore });
      },
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return fail(403, "forbidden", "This request was rejected as cross-site.");
        }
        const user = await authenticateApiUser(request);
        if (!user) return fail(401, "unauthorized", "Sign in to process this video.");
        const body = await readJsonBody(request);
        const lessonId = typeof body?.["lessonId"] === "string" ? body["lessonId"].trim() : "";
        if (!lessonId) return fail(400, "invalid_request", "A lesson ID is required.");
        const ingestion = await advanceIngestion({
          supabase: user.supabase,
          userId: user.userId,
          lessonId,
          retry: body?.["retry"] === true,
        });
        return Response.json({ status: "ok", ingestion }, { headers: noStore });
      },
      ...unsupportedMethods(["GET", "POST"]),
    },
  },
});
