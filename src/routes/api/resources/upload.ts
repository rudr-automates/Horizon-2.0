import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiUser, isSameOrigin } from "@/server/auth/api-user.server";
import { ingestLessonResource } from "@/server/ingestion/service.server";
import { MAX_RESOURCE_BYTES } from "@/server/ingestion/extract.server";

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

export const Route = createFileRoute("/api/resources/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isSameOrigin(request)) {
          return Response.json({ status: "error", code: "forbidden" }, { status: 403 });
        }
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESOURCE_BYTES + 512_000) {
          return Response.json(
            {
              status: "error",
              code: "invalid_file",
              message: "Files must be 10 MB or smaller.",
            },
            { status: 413 },
          );
        }

        const user = await authenticateApiUser(request);
        if (!user) {
          return Response.json(
            { status: "error", code: "unauthorized", message: "Sign in again to upload." },
            { status: 401, headers: { "cache-control": "no-store" } },
          );
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json(
            { status: "error", code: "invalid_file", message: "The upload was not readable." },
            { status: 400 },
          );
        }
        const file = form.get("file");
        const lessonId = String(form.get("lessonId") ?? "").trim();
        if (!(file instanceof File) || !lessonId) {
          return Response.json(
            {
              status: "error",
              code: "invalid_file",
              message: "Choose a file and a lesson before uploading.",
            },
            { status: 400 },
          );
        }
        const filename = file.name.replace(/[\\/]/g, "_").slice(-200);
        const extension = filename.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
        if (!ALLOWED_EXTENSIONS.has(extension)) {
          return Response.json(
            {
              status: "error",
              code: "unsupported_type",
              message: `Supported files: PDF, PPTX, text, Markdown, captions and common code files.`,
            },
            { status: 415 },
          );
        }
        if (file.size === 0) {
          return Response.json(
            { status: "error", code: "empty_content", message: "The selected file is empty." },
            { status: 400 },
          );
        }

        const result = await ingestLessonResource({
          supabase: user.supabase,
          userId: user.userId,
          lessonId,
          filename,
          mimeType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        const status =
          result.status === "ready" ? 201 : result.code === "database_unavailable" ? 503 : 400;
        return Response.json(result, {
          status,
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
