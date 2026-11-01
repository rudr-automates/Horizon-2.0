import { createFileRoute } from "@tanstack/react-router";
import { randomUUID } from "node:crypto";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";
import {
  contentTypeFor,
  ingestLessonResource,
  RESOURCE_BUCKET,
} from "@/server/ingestion/service.server";
import { unsupportedMethods } from "@/server/http/responses";
import { MAX_RESOURCE_BYTES } from "@/server/ingestion/extract.server";
import {
  createSignedUpload,
  extensionOf,
  isOwnedPath,
  readJsonBody,
  removeObject,
  safeFilename,
} from "@/server/storage/signed-upload.server";

const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".markdown",
  ".vtt",
  ".srt",
  ".webvtt",
  ".py",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".json",
  ".csv",
  ".css",
  ".html",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".rs",
  ".go",
  ".rb",
  ".php",
  ".sql",
  ".sh",
  ".yaml",
  ".yml",
  ".toml",
]);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function rejection(status: number, code: string, message: string): Response {
  return json({ status: "error", code, message }, status);
}

/**
 * Uploads are split into two small JSON calls because a Vercel Function cannot
 * receive the 10 MB file body. "sign" authorises one object path inside the
 * learner's own folder; the browser then uploads directly to Supabase Storage;
 * "complete" downloads the object server-side, extracts and indexes it.
 */
export const Route = createFileRoute("/api/resources/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return rejection(403, "forbidden", "This upload was rejected as a cross-site request.");
        }

        const user = await authenticateApiUser(request);
        if (!user) {
          return rejection(401, "unauthorized", "Sign in again to upload.");
        }

        const body = await readJsonBody(request);
        if (!body) {
          return rejection(400, "invalid_file", "The upload request was not readable.");
        }

        const action = String(body["action"] ?? "");
        const lessonId = String(body["lessonId"] ?? "").trim();
        const filename = safeFilename(body["filename"]);
        const availability = body["availability"];
        const alignmentStartSeconds = body["alignmentStartSeconds"] === undefined
          ? undefined
          : Number(body["alignmentStartSeconds"]);
        const alignmentEndSeconds = body["alignmentEndSeconds"] === undefined
          ? undefined
          : Number(body["alignmentEndSeconds"]);
        if (!lessonId) {
          return rejection(400, "invalid_file", "Choose a lesson before uploading.");
        }
        if (!filename) {
          return rejection(400, "invalid_file", "Choose a file before uploading.");
        }
        const extension = extensionOf(filename);
        if (!ALLOWED_EXTENSIONS.has(extension)) {
          return rejection(
            415,
            "unsupported_type",
            "Supported files: PDF, PPTX, text, Markdown, captions and common code files.",
          );
        }

        if (action === "sign") {
          const size = Number(body["size"] ?? 0);
          if (!Number.isFinite(size) || size <= 0) {
            return rejection(400, "empty_content", "The selected file is empty.");
          }
          if (size > MAX_RESOURCE_BYTES) {
            return rejection(413, "invalid_file", "Files must be 10 MB or smaller.");
          }
          const path = `${user.userId}/${randomUUID()}${extension}`;
          const signed = await createSignedUpload(user.supabase, RESOURCE_BUCKET, path);
          if (!signed.ok) return rejection(503, "storage_unavailable", signed.message);
          return json({
            status: "ok",
            bucket: signed.upload.bucket,
            path: signed.upload.path,
            token: signed.upload.token,
            // The bucket allowlist is strict, so the browser must not guess.
            contentType: contentTypeFor(extension),
          });
        }

        if (action === "complete") {
          const path = String(body["path"] ?? "");
          if (!isOwnedPath(user.userId, path) || extensionOf(path) !== extension) {
            return rejection(403, "forbidden", "That uploaded file does not belong to you.");
          }
          const stored = await user.supabase.storage.from(RESOURCE_BUCKET).download(path);
          if (stored.error || !stored.data) {
            return rejection(
              400,
              "storage_unavailable",
              "The uploaded file could not be read back. Upload it again.",
            );
          }
          const bytes = new Uint8Array(await stored.data.arrayBuffer());
          if (bytes.byteLength === 0) {
            await removeObject(user.supabase, RESOURCE_BUCKET, path);
            return rejection(400, "empty_content", "The selected file is empty.");
          }
          if (bytes.byteLength > MAX_RESOURCE_BYTES) {
            await removeObject(user.supabase, RESOURCE_BUCKET, path);
            return rejection(413, "invalid_file", "Files must be 10 MB or smaller.");
          }

          const result = await ingestLessonResource({
            supabase: user.supabase,
            userId: user.userId,
            lessonId,
            filename,
            mimeType: stored.data.type,
            bytes,
            storedPath: path,
            availability: availability === "always" || availability === "timeline" || availability === "unknown"
              ? availability
              : "unknown",
            ...(alignmentStartSeconds === undefined ? {} : { alignmentStartSeconds }),
            ...(alignmentEndSeconds === undefined ? {} : { alignmentEndSeconds }),
          });
          if (result.status !== "ready") {
            // Nothing references the object yet, so take it out of storage.
            await removeObject(user.supabase, RESOURCE_BUCKET, path);
            const status =
              result.code === "database_unavailable" || result.code === "storage_unavailable"
                ? 503
                : result.code === "lesson_not_found"
                  ? 404
                  : 400;
            return json(result, status);
          }
          return json(result, 201);
        }

        return rejection(400, "invalid_file", "Unsupported upload step.");
      },
      ...unsupportedMethods(["POST"]),
    },
  },
});
