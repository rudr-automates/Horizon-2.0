import { createFileRoute } from "@tanstack/react-router";
import { getWhisperAdmin, validWorkerToken } from "@/server/whisper/admin.server";
import { readJsonBody } from "@/server/storage/signed-upload.server";
import { ingestLessonResource } from "@/server/ingestion/service.server";
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Segment = { start: number; end: number; text: string };
function fail(status: number, code: string) {
  return Response.json(
    { status: "error", code },
    { status, headers: { "cache-control": "no-store" } },
  );
}
function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000),
    m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000),
    rem = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rem).padStart(3, "0")}`;
}

export const Route = createFileRoute("/api/whisper/worker/jobs/$jobId")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!validWorkerToken(request)) return fail(401, "unauthorized");
        const body = await readJsonBody(request);
        const action = body?.["action"];
        const leaseToken = typeof body?.["leaseToken"] === "string" ? body["leaseToken"] : "";
        const admin = getWhisperAdmin();
        if (!admin) return fail(503, "queue_unconfigured");
        const { data: job } = await admin
          .from("transcription_jobs")
          .select("*")
          .eq("id", params.jobId)
          .eq("lease_token", leaseToken)
          .maybeSingle();
        if (!job || !leaseToken) return fail(409, "lease_expired");

        if (action === "heartbeat") {
          const stages = new Set([
            "claimed",
            "downloading",
            "extracting_audio",
            "transcribing",
            "normalizing",
            "indexing",
          ]);
          const requestedStage =
            typeof body?.["stage"] === "string" ? body["stage"] : "transcribing";
          if (!stages.has(requestedStage)) return fail(400, "invalid_stage");
          const progress = { stage: requestedStage };
          const { error } = await admin
            .from("transcription_jobs")
            .update({
              status: requestedStage,
              progress,
              heartbeat_at: new Date().toISOString(),
              lease_expires_at: new Date(Date.now() + 180_000).toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("lease_token", leaseToken);
          return error
            ? fail(409, "lease_expired")
            : Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
        }
        if (action === "failed") {
          const exhausted = job.attempt_count >= job.max_attempts;
          const delay = Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, job.attempt_count - 1));
          await admin
            .from("transcription_jobs")
            .update({
              status: exhausted ? "failed" : "retry_wait",
              next_attempt_at: new Date(Date.now() + delay).toISOString(),
              worker_id: null,
              lease_token: null,
              lease_expires_at: null,
              error_code:
                typeof body?.["code"] === "string" ? body["code"].slice(0, 80) : "worker_failed",
              error_message:
                typeof body?.["message"] === "string"
                  ? body["message"].slice(0, 300)
                  : "Transcription failed.",
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("lease_token", leaseToken);
          return Response.json(
            { status: exhausted ? "failed" : "retry_wait" },
            { headers: { "cache-control": "no-store" } },
          );
        }
        if (action !== "result") return fail(400, "invalid_action");

        const raw = body?.["segments"];
        const duration = Number(body?.["durationSeconds"]);
        if (
          !Array.isArray(raw) ||
          raw.length < 1 ||
          raw.length > 50_000 ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          duration > 24 * 60 * 60
        )
          return fail(400, "invalid_transcript");
        const segments: Segment[] = [];
        let previousEnd = 0,
          charCount = 0;
        for (const item of raw) {
          if (typeof item !== "object" || item === null) return fail(400, "invalid_transcript");
          const segment = item as Record<string, unknown>;
          const start = Number(segment["start"]),
            end = Number(segment["end"]);
          const text = typeof segment["text"] === "string" ? segment["text"].trim() : "";
          if (
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            start < 0 ||
            end <= start ||
            start < previousEnd ||
            end > duration + 0.25 ||
            !text ||
            text.length > 5_000
          )
            return fail(400, "invalid_transcript");
          previousEnd = end;
          charCount += text.length;
          if (charCount > 300_000) return fail(413, "transcript_too_large");
          segments.push({ start, end, text });
        }
        const { data: lesson } = await admin
          .from("lessons")
          .select("duration_seconds")
          .eq("id", job.lesson_id)
          .eq("user_id", job.user_id)
          .maybeSingle();
        if (!lesson) return fail(404, "lesson_not_found");
        if (lesson.duration_seconds > 0 && Math.abs(lesson.duration_seconds - duration) > 2)
          return fail(400, "duration_mismatch");
        const vtt =
          "WEBVTT\n\n" +
          segments
            .map(
              (segment) =>
                `${stamp(segment.start)} --> ${stamp(segment.end)}\n${segment.text.replace(/[<>]/g, "")}`,
            )
            .join("\n\n");
        if (new TextEncoder().encode(vtt).byteLength > 9 * 1024 * 1024)
          return fail(413, "transcript_too_large");
        await admin
          .from("transcription_jobs")
          .update({
            status: "indexing",
            progress: { stage: "indexing" },
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lease_token", leaseToken);
        const result = await ingestLessonResource({
          supabase: admin as unknown as SupabaseClient<Database>,
          userId: job.user_id,
          lessonId: job.lesson_id,
          filename: "whisper-transcript.vtt",
          mimeType: "text/vtt",
          bytes: new TextEncoder().encode(vtt),
          provenance: {
            transcript_source: "local-whisper",
            model: body?.["model"] ?? "unknown",
            language: body?.["language"] ?? null,
            model_backend: body?.["backend"] ?? "unknown",
            segment_count: segments.length,
            media_duration_seconds: duration,
          },
        });
        if (result.status === "error" && result.code !== "transcript_exists") {
          const exhausted = job.attempt_count >= job.max_attempts;
          await admin
            .from("transcription_jobs")
            .update({
              status: exhausted ? "failed" : "retry_wait",
              next_attempt_at: new Date(Date.now() + 30_000).toISOString(),
              worker_id: null,
              lease_token: null,
              lease_expires_at: null,
              error_code: result.code,
              error_message: result.message.slice(0, 300),
            })
            .eq("id", job.id)
            .eq("lease_token", leaseToken);
          return fail(422, "ingestion_failed");
        }
        const alreadyIndexed = result.status === "error";
        const metadataString = (value: unknown) =>
          typeof value === "string" ? value.slice(0, 120) : null;
        if (!alreadyIndexed) {
          const { error: lessonWriteError } = await admin
            .from("lessons")
            .update({
              duration_seconds: duration,
              transcript: segments,
              transcript_status: "available",
            })
            .eq("id", job.lesson_id)
            .eq("user_id", job.user_id);
          if (lessonWriteError) return fail(503, "transcript_panel_sync_failed");
        }
        await admin
          .from("transcription_jobs")
          .update({
            status: "ready",
            resource_id: result.status === "ready" ? result.resourceId : null,
            model_metadata: {
              model: metadataString(body?.["model"]),
              language: metadataString(body?.["language"]),
              backend: metadataString(body?.["backend"]),
            },
            progress: {
              stage: "ready",
              segmentCount: segments.length,
              ...(alreadyIndexed
                ? { message: "An indexed transcript already exists; it was preserved." }
                : {}),
            },
            heartbeat_at: new Date().toISOString(),
            lease_token: null,
            lease_expires_at: null,
            worker_id: null,
            error_code: null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lease_token", leaseToken);
        return Response.json({ status: "ready" }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
