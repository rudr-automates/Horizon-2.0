import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";
import {
  createSignedUpload,
  extensionOf,
  inspectObject,
  isOwnedPath,
  readJsonBody,
  removeObject,
  safeFilename,
} from "@/server/storage/signed-upload.server";
import { unsupportedMethods } from "@/server/http/responses";

/** 200 MB. The bucket allows 250 MB; the lower app limit leaves room for overhead. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

const VIDEO_BUCKET = "lesson-videos";
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm"]);

type VideoKind = "mp4" | "webm";

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
  return Response.json(
    { status: "error", code, message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Reads the storage:// reference stored on a lesson into bucket and object path. */
function storedObjectOf(videoUrl: string): { bucket: string; path: string } | null {
  if (!videoUrl.startsWith("storage://")) return null;
  const rest = videoUrl.slice("storage://".length);
  const slash = rest.indexOf("/");
  if (slash < 1 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/**
 * Videos are far larger than a Vercel Function may receive (4.5 MB), so the
 * browser asks for a signed upload URL, streams the file straight into the
 * learner's own private folder, and only then asks the server to verify the
 * stored object and attach it to a lesson. No endpoint ever buffers the video.
 */
export const Route = createFileRoute("/api/videos/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return error(403, "forbidden", "This upload was rejected as a cross-site request.");
        }

        const user = await authenticateApiUser(request);
        if (!user) return error(401, "unauthorized", "Sign in again to upload.");

        const body = await readJsonBody(request);
        if (!body) return error(400, "invalid_file", "The upload request was not readable.");

        const action = String(body["action"] ?? "");
        const rawLessonId = String(body["lessonId"] ?? "").trim();
        const title = String(body["title"] ?? "")
          .trim()
          .slice(0, 200);
        const filename = safeFilename(body["filename"]);
        const extension = extensionOf(filename);
        if (!filename) return error(400, "invalid_file", "Choose a video file to upload.");
        if (!VIDEO_EXTENSIONS.has(extension)) {
          return error(415, "unsupported_type", "Supported video files: MP4 and WebM.");
        }
        if (!rawLessonId && !title) {
          return error(400, "invalid_file", "Give the lesson a title before uploading.");
        }

        // An existing lesson may only receive a new video from its owner.
        if (rawLessonId) {
          const { data: lesson, error: lessonError } = await user.supabase
            .from("lessons")
            .select("id,user_id,is_demo")
            .eq("id", rawLessonId)
            .maybeSingle();
          if (lessonError)
            return error(503, "database_unavailable", "The lesson could not be loaded.");
          if (!lesson) return error(404, "lesson_not_found", "That lesson does not exist.");
          if (lesson.is_demo || lesson.user_id !== user.userId) {
            return error(403, "forbidden", "You can only add video to lessons you own.");
          }
        }

        if (action === "sign") {
          const size = Number(body["size"] ?? 0);
          if (!Number.isFinite(size) || size <= 0) {
            return error(400, "empty_content", "The selected file is empty.");
          }
          if (size > MAX_VIDEO_BYTES) {
            return error(413, "file_too_large", "Videos must be 200 MB or smaller.");
          }
          const path = `${user.userId}/${randomUUID()}${extension}`;
          const signed = await createSignedUpload(user.supabase, VIDEO_BUCKET, path);
          if (!signed.ok) return error(503, "storage_unavailable", signed.message);
          return Response.json(
            {
              status: "ok",
              bucket: signed.upload.bucket,
              path: signed.upload.path,
              token: signed.upload.token,
              contentType: extension === ".mp4" ? "video/mp4" : "video/webm",
            },
            { headers: { "cache-control": "no-store" } },
          );
        }

        if (action === "complete") {
          const path = String(body["path"] ?? "");
          if (!isOwnedPath(user.userId, path) || extensionOf(path) !== extension) {
            return error(403, "forbidden", "That uploaded file does not belong to you.");
          }
          const object = await inspectObject(user.supabase, VIDEO_BUCKET, path, 32);
          if (!object) {
            await removeObject(user.supabase, VIDEO_BUCKET, path);
            return error(
              400,
              "invalid_file",
              "The uploaded video could not be verified. Upload it again.",
            );
          }
          if (object.size > MAX_VIDEO_BYTES) {
            await removeObject(user.supabase, VIDEO_BUCKET, path);
            return error(413, "file_too_large", "Videos must be 200 MB or smaller.");
          }
          const kind = detectVideoKind(object.head);
          if (
            !kind ||
            (extension === ".mp4" && kind !== "mp4") ||
            (extension === ".webm" && kind !== "webm")
          ) {
            await removeObject(user.supabase, VIDEO_BUCKET, path);
            return error(415, "unsupported_type", "This file is not a playable MP4 or WebM video.");
          }

          const videoUrl = `storage://${VIDEO_BUCKET}/${path}`;
          let previousVideoUrl: string | null = null;
          let lessonId = rawLessonId;
          if (rawLessonId) {
            const { data: current } = await user.supabase
              .from("lessons")
              .select("video_url")
              .eq("id", rawLessonId)
              .eq("user_id", user.userId)
              .maybeSingle();
            previousVideoUrl = current?.video_url ?? null;
          } else {
            lessonId = randomUUID();
          }

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
            await removeObject(user.supabase, VIDEO_BUCKET, path);
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
              await removeObject(user.supabase, previous.bucket, previous.path);
            }
          }

          return Response.json(
            {
              status: "ready",
              lessonId: write.data.id,
              videoUrl,
              message: rawLessonId
                ? "Video replaced. Horizon is preparing its transcript automatically."
                : "Video added. Horizon is preparing its transcript automatically.",
            },
            { status: 201, headers: { "cache-control": "no-store" } },
          );
        }

        return error(400, "invalid_file", "Unsupported upload step.");
      },
      ...unsupportedMethods(["POST"]),
    },
  },
});
