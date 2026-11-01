import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";
import { getWhisperAdmin } from "@/server/whisper/admin.server";
import { readJsonBody } from "@/server/storage/signed-upload.server";
import { isOwnedPath } from "@/server/storage/signed-upload.server";

const noStore = { "cache-control": "no-store" };
function fail(status: number, code: string, message: string) {
  return Response.json({ status: "error", code, message }, { status, headers: noStore });
}

export const Route = createFileRoute("/api/whisper/jobs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await authenticateApiUser(request);
        if (!user) return fail(401, "unauthorized", "Sign in to view transcription status.");
        const lessonId = new URL(request.url).searchParams.get("lessonId");
        if (!lessonId) return fail(400, "invalid_request", "A lesson ID is required.");
        const { data, error } = await user.supabase
          .from("transcription_jobs")
          .select(
            "id,status,attempt_count,max_attempts,progress,error_message,created_at,updated_at",
          )
          .eq("lesson_id", lessonId)
          .eq("user_id", user.userId)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return fail(503, "database_unavailable", "Transcription status is unavailable.");
        return Response.json({ status: "ok", job: data }, { headers: noStore });
      },
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) return fail(403, "forbidden", "Cross-site request rejected.");
        const user = await authenticateApiUser(request);
        if (!user) return fail(401, "unauthorized", "Sign in to request transcription.");
        const body = await readJsonBody(request);
        const lessonId = typeof body?.["lessonId"] === "string" ? body["lessonId"] : "";
        if (!lessonId) return fail(400, "invalid_request", "A lesson ID is required.");
        const { data: lesson, error: lessonError } = await user.supabase
          .from("lessons")
          .select("id,user_id,is_demo,video_url")
          .eq("id", lessonId)
          .maybeSingle();
        if (lessonError)
          return fail(503, "database_unavailable", "The lesson could not be loaded.");
        if (!lesson || lesson.user_id !== user.userId || lesson.is_demo)
          return fail(404, "lesson_not_found", "That lesson is unavailable.");
        const prefix = "storage://lesson-videos/";
        if (!lesson.video_url.startsWith(prefix))
          return fail(
            400,
            "unsupported_source",
            "Automatic transcription supports private MP4/WebM uploads only. Add authorised captions for linked videos.",
          );
        const mediaPath = lesson.video_url.slice(prefix.length);
        if (!isOwnedPath(user.userId, mediaPath) || !/\.(mp4|webm)$/i.test(mediaPath))
          return fail(403, "forbidden", "The stored video is not an authorised upload.");
        const admin = getWhisperAdmin();
        if (!admin)
          return fail(
            503,
            "worker_unconfigured",
            "The server transcription queue is not configured yet.",
          );
        const existing = await admin
          .from("transcription_jobs")
          .select("id,status")
          .eq("lesson_id", lessonId)
          .eq("media_path", mediaPath)
          .maybeSingle();
        if (existing.data) {
          if (existing.data.status === "failed") {
            const retry = await admin
              .from("transcription_jobs")
              .update({
                status: "queued",
                attempt_count: 0,
                next_attempt_at: new Date().toISOString(),
                error_code: null,
                error_message: null,
              })
              .eq("id", existing.data.id)
              .select("id,status")
              .single();
            if (retry.error)
              return fail(503, "database_unavailable", "The transcription could not be retried.");
            return Response.json(
              { status: "queued", job: retry.data },
              { status: 202, headers: noStore },
            );
          }
          return Response.json(
            { status: existing.data.status, job: existing.data },
            { status: 202, headers: noStore },
          );
        }
        const { data: job, error } = await admin
          .from("transcription_jobs")
          .insert({
            user_id: user.userId,
            lesson_id: lessonId,
            media_path: mediaPath,
          })
          .select("id,status")
          .single();
        if (error)
          if (error.code === "23505") {
            const { data: raced } = await admin
              .from("transcription_jobs")
              .select("id,status")
              .eq("lesson_id", lessonId)
              .eq("media_path", mediaPath)
              .maybeSingle();
            if (raced)
              return Response.json(
                { status: raced.status, job: raced },
                { status: 202, headers: noStore },
              );
          }
        if (error)
          return fail(503, "database_unavailable", "The transcription could not be queued.");
        return Response.json({ status: "queued", job }, { status: 202, headers: noStore });
      },
    },
  },
});
