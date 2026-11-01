import { createFileRoute } from "@tanstack/react-router";
import { getWhisperAdmin, validWorkerToken } from "@/server/whisper/admin.server";
import { readJsonBody } from "@/server/storage/signed-upload.server";

export const Route = createFileRoute("/api/whisper/worker/claim")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!validWorkerToken(request))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await readJsonBody(request);
        const workerId =
          typeof body?.["workerId"] === "string" ? body["workerId"].slice(0, 120) : "";
        if (!workerId) return Response.json({ error: "worker_id_required" }, { status: 400 });
        const admin = getWhisperAdmin();
        if (!admin) return Response.json({ error: "queue_unconfigured" }, { status: 503 });
        const { data, error } = await admin
          .rpc("claim_transcription_job", { p_worker_id: workerId })
          .maybeSingle();
        if (error || !data)
          return Response.json({ job: null }, { headers: { "cache-control": "no-store" } });
        if (!data.lease_token)
          return Response.json({ error: "lease_unavailable" }, { status: 503 });
        const { data: lesson } = await admin
          .from("lessons")
          .select("duration_seconds,title")
          .eq("id", data.lesson_id)
          .eq("user_id", data.user_id)
          .maybeSingle();
        const { data: signed, error: storageError } = await admin.storage
          .from("lesson-videos")
          .createSignedUrl(data.media_path, 600);
        if (storageError || !signed?.signedUrl || !lesson) {
          await admin
            .from("transcription_jobs")
            .update({
              status: "retry_wait",
              next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
              lease_token: null,
              lease_expires_at: null,
              worker_id: null,
              error_code: "media_unavailable",
              error_message: "The private video could not be signed for download.",
            })
            .eq("id", data.id)
            .eq("lease_token", data.lease_token);
          return Response.json({ job: null }, { headers: { "cache-control": "no-store" } });
        }
        return Response.json(
          {
            job: {
              id: data.id,
              lessonId: data.lesson_id,
              title: lesson.title,
              durationSeconds: lesson.duration_seconds,
              downloadUrl: signed.signedUrl,
              leaseToken: data.lease_token,
            },
          },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
