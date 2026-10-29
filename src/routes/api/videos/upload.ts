import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";

/** 200 MB. The bucket allows 250 MB; the lower app limit leaves room for form overhead. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const VIDEO_BUCKET = "lesson-videos";
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm"]);

type VideoKind = "mp4" | "webm";

function extensionOf(filename: string): string {
  return filename.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
}

/**
 * Container signatures are checked so a renamed executable cannot reach the
 * bucket, which only validates the MIME type the client declares.
 */
function detectVideoKind(bytes: Uint8Array): VideoKind | null {
  if (bytes.byteLength < 16) return null;
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "mp4";
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "webm";
  }
  return null;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ status: "error", code, message }, { status });
}

/** Reads the storage:// reference stored on a lesson into bucket and object path. */
function storedObjectOf(videoUrl: string): { bucket: string; path: string } | null {
  if (!videoUrl.startsWith("storage://")) return null;
  const rest = videoUrl.slice("storage://".length);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

export const Route = createFileRoute("/api/videos/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return error(403, "forbidden", "This upload was rejected as a cross-site request.");
        }
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_VIDEO_BYTES + 512_000) {
          return error(413, "file_too_large", "Videos must be 200 MB or smaller.");
        }

        const user = await authenticateApiUser(request);
        if (!user) {
          return new Response(
            JSON.stringify({
              status: "error",
              code: "unauthorized",
              message: "Sign in again to upload.",
            }),
            {
              status: 401,
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            },
          );
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return error(400, "invalid_file", "The upload was not readable.");
        }

        const file = form.get("file");
        const rawLessonId = String(form.get("lessonId") ?? "").trim();
        const title = String(form.get("title") ?? "")
          .trim()
          .slice(0, 200);
        if (!(file instanceof File)) {
          return error(400, "invalid_file", "Choose a video file to upload.");
        }
        if (!rawLessonId && !title) {
          return error(400, "invalid_file", "Give the lesson a title before uploading.");
        }

        const filename = file.name.replace(/[\\/]/g, "_").slice(-200);
        const extension = extensionOf(filename);
        if (!VIDEO_EXTENSIONS.has(extension)) {
          return error(415, "unsupported_type", "Supported video files: MP4 and WebM.");
        }
        if (file.size === 0) {
          return error(400, "empty_content", "The selected file is empty.");
        }
        if (file.size > MAX_VIDEO_BYTES) {
          return error(413, "file_too_large", "Videos must be 200 MB or smaller.");
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = detectVideoKind(bytes);
        if (
          !kind ||
          (extension === ".mp4" && kind !== "mp4") ||
          (extension === ".webm" && kind !== "webm")
        ) {
          return error(415, "unsupported_type", "This file is not a playable MP4 or WebM video.");
        }

        // An existing lesson may only receive a new video from its owner.
        let previousVideoUrl: string | null = null;
        let lessonId = rawLessonId;
        if (rawLessonId) {
          const { data: lesson, error: lessonError } = await user.supabase
            .from("lessons")
            .select("id,user_id,is_demo,video_url,title")
            .eq("id", rawLessonId)
            .maybeSingle();
          if (lessonError) {
            return error(503, "database_unavailable", "The lesson could not be loaded.");
          }
          if (!lesson) {
            return error(404, "lesson_not_found", "That lesson does not exist.");
          }
          if (lesson.is_demo || lesson.user_id !== user.userId) {
            return error(403, "forbidden", "You can only add video to lessons you own.");
          }
          previousVideoUrl = lesson.video_url;
        } else {
          lessonId = randomUUID();
        }

        const objectPath = `${user.userId}/${lessonId}-${randomUUID().slice(0, 8)}${extension}`;
        const contentType = kind === "mp4" ? "video/mp4" : "video/webm";
        const upload = await user.supabase.storage
          .from(VIDEO_BUCKET)
          .upload(objectPath, bytes, { contentType, upsert: false });
        if (upload.error) {
          return error(
            503,
            "storage_unavailable",
            "The private video store rejected this upload. Check that the video storage migration is applied.",
          );
        }

        const videoUrl = `storage://${VIDEO_BUCKET}/${objectPath}`;
        const write = rawLessonId
          ? await user.supabase
              .from("lessons")
              .update({ video_url: videoUrl, provider: "direct" })
              .eq("id", rawLessonId)
              .eq("user_id", user.userId)
              .select("id")
              .maybeSingle()
          : await user.supabase
              .from("lessons")
              .insert({
                id: lessonId,
                user_id: user.userId,
                title,
                video_url: videoUrl,
                provider: "direct",
                transcript_status: "unavailable",
                duration_seconds: 0,
              })
              .select("id")
              .single();

        if (write.error || !write.data) {
          await user.supabase.storage.from(VIDEO_BUCKET).remove([objectPath]);
          if (write.error) {
            return error(
              503,
              "database_unavailable",
              "The lesson record could not be updated, so the video was not kept.",
            );
          }
          // No row matched: RLS refused the write because the lesson is not yours.
          return error(403, "forbidden", "You can only add video to lessons you own.");
        }

        // The replaced video is removed only after the lesson points elsewhere.
        if (previousVideoUrl && previousVideoUrl !== videoUrl) {
          const previous = storedObjectOf(previousVideoUrl);
          if (previous?.bucket === VIDEO_BUCKET) {
            await user.supabase.storage
              .from(previous.bucket)
              .remove([previous.path])
              .catch(() => null);
          }
        }

        return Response.json(
          {
            status: "ready",
            lessonId: write.data.id,
            videoUrl,
            message: rawLessonId
              ? "Video replaced. Its duration will be recorded when it first plays."
              : "Video added. Add captions in the Transcript tab before asking timestamped questions.",
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
