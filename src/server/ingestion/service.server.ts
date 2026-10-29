import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAiRuntime } from "../ai/runtime.server";
import { JINA_EMBEDDING_MODEL } from "../ai/embeddings/jina";
import { embeddingSpaceKey, embeddingSpaceFor } from "../ai/embeddings/space";
import type { AiDatabase } from "../retrieval/ai-database";
import type { ResourceKind } from "../retrieval/types";
import { parseCaptions } from "@/lib/learning";
import {
  extractResource,
  ExtractionError,
  MAX_RESOURCE_BYTES,
  type ExtractedChunk,
  type ExtractionErrorCode,
} from "./extract.server";

export const RESOURCE_BUCKET = "learning-resources";

export type IngestFailureCode =
  | ExtractionErrorCode
  | "lesson_not_found"
  | "duplicate_resource"
  | "transcript_exists"
  | "storage_unavailable"
  | "database_unavailable"
  | "invalid_file";

export interface IngestFailure {
  status: "error";
  code: IngestFailureCode;
  message: string;
}

export interface IngestSuccess {
  status: "ready";
  resourceId: string;
  kind: ResourceKind;
  title: string;
  chunkCount: number;
  embeddedChunks: number;
  embeddingStatus: "complete" | "partial" | "unavailable";
}

export type IngestResult = IngestSuccess | IngestFailure;

type AiClient = SupabaseClient<AiDatabase>;

const INSERT_BATCH = 40;
const EMBED_BATCH = 32;

function failure(code: IngestFailureCode, message: string): IngestFailure {
  return { status: "error", code, message };
}

function extensionOf(filename: string): string {
  return filename.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] ?? "";
}

/** Browsers disagree about text and code MIME types; the bucket allowlist is strict. */
function contentTypeFor(extension: string): string {
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".pptx")
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".vtt" || extension === ".webvtt") return "text/vtt";
  if (extension === ".srt") return "application/x-subrip";
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv";
  if (extension === ".py") return "text/x-python";
  if (extension === ".ts" || extension === ".tsx") return "application/typescript";
  if ([".js", ".jsx", ".mjs"].includes(extension)) return "text/javascript";
  return "text/plain";
}

function hashChunks(kind: ResourceKind, chunks: ExtractedChunk[]): string {
  const hash = createHash("sha256");
  hash.update(kind);
  hash.update("\0");
  hash.update(chunks.map((chunk) => chunk.text).join("\n\n"));
  return hash.digest("hex");
}

function chunkRow(resourceId: string, index: number, chunk: ExtractedChunk) {
  const locator = chunk.locator;
  return {
    resource_id: resourceId,
    chunk_index: index,
    heading: chunk.heading ?? null,
    text: chunk.text,
    locator_kind: locator.kind,
    video_start_seconds: locator.kind === "video" ? locator.startSeconds : null,
    video_end_seconds: locator.kind === "video" ? locator.endSeconds : null,
    page_number: locator.kind === "page" ? locator.pageNumber : null,
    slide_number: locator.kind === "slide" ? locator.slideNumber : null,
    section:
      locator.kind === "text" ? (locator.section ?? null) : chunk.heading ? chunk.heading : null,
    content_hash: createHash("sha256").update(chunk.text).digest("hex"),
    metadata: {},
  };
}

interface StoredChunkRow {
  resource_id: string;
  chunk_index: number;
  heading: string | null;
  text: string;
  locator_kind: "video" | "page" | "slide" | "text";
  video_start_seconds: number | null;
  video_end_seconds: number | null;
  page_number: number | null;
  slide_number: number | null;
  section: string | null;
  content_hash: string;
  metadata: Record<string, unknown>;
  embedding?: string;
  embedding_space_key?: string;
  embedding_provider?: string;
  embedding_model?: string;
  embedding_dimension?: number;
  embedding_version?: string;
}

interface EmbeddedChunkRows {
  rows: StoredChunkRow[];
  embedded: number;
  error: string | undefined;
}

async function embedChunks(
  chunks: ExtractedChunk[],
  rows: StoredChunkRow[],
): Promise<EmbeddedChunkRows> {
  const runtime = getAiRuntime();
  const jina = runtime.embeddingRegistry.resolve(
    JINA_EMBEDDING_MODEL.providerId,
    JINA_EMBEDDING_MODEL.modelId,
  );
  if (!jina?.provider.isConfigured()) {
    return { rows, embedded: 0, error: "not_configured" };
  }
  const space = embeddingSpaceKey(embeddingSpaceFor(JINA_EMBEDDING_MODEL));
  const withVectors: StoredChunkRow[] = rows.slice();
  let embedded = 0;
  try {
    for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
      const batch = chunks.slice(start, start + EMBED_BATCH);
      const result = await runtime.embeddings.embed({
        providerId: JINA_EMBEDDING_MODEL.providerId,
        modelId: JINA_EMBEDDING_MODEL.modelId,
        inputs: batch.map((chunk) => chunk.text),
        purpose: "document",
        timeoutMs: 45_000,
      });
      result.vectors.forEach((vector, index) => {
        const target = withVectors[start + index];
        if (!target) return;
        target.embedding = `[${vector.join(",")}]`;
        target.embedding_space_key = space;
        target.embedding_provider = JINA_EMBEDDING_MODEL.providerId;
        target.embedding_model = JINA_EMBEDDING_MODEL.modelId;
        target.embedding_dimension = JINA_EMBEDDING_MODEL.dimension;
        target.embedding_version = JINA_EMBEDDING_MODEL.spaceVersion;
        embedded += 1;
      });
    }
    return { rows: withVectors, embedded, error: undefined };
  } catch (error) {
    // Keyword retrieval is a safe degradation: the source is still usable, but
    // the caller is told that semantic search is incomplete for this upload.
    return {
      rows: withVectors,
      embedded,
      error:
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "provider_error",
    };
  }
}

export async function ingestLessonResource(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lessonId: string;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}): Promise<IngestResult> {
  if (!input.userId.trim()) return failure("database_unavailable", "No authenticated learner.");
  if (input.bytes.byteLength > MAX_RESOURCE_BYTES) {
    return failure("invalid_file", "Files must be 10 MB or smaller.");
  }

  const { data: lesson, error: lessonError } = await input.supabase
    .from("lessons")
    .select("id,title,course_id,duration_seconds")
    .eq("id", input.lessonId)
    .maybeSingle();
  if (lessonError) return failure("database_unavailable", "The lesson could not be loaded.");
  if (!lesson)
    return failure("lesson_not_found", "That lesson is unavailable or you do not have access.");

  let extracted;
  try {
    extracted = await extractResource({
      filename: input.filename,
      bytes: input.bytes,
      lessonId: lesson.id,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      lessonDurationSeconds: lesson.duration_seconds,
    });
  } catch (error) {
    if (error instanceof ExtractionError) return failure(error.code, error.message);
    return failure("invalid_file", "The file could not be read.");
  }
  if (!extracted.chunks.length)
    return failure("empty_content", "The file contains no readable text.");

  const db = input.supabase as unknown as AiClient;
  const contentHash = hashChunks(extracted.kind, extracted.chunks);

  const existing = await db
    .from("learning_resources")
    .select("id")
    .eq("owner_id", input.userId)
    .eq("lesson_id", lesson.id)
    .eq("content_hash", contentHash)
    .maybeSingle();
  if (existing.data) {
    return failure("duplicate_resource", "This exact file is already indexed for this lesson.");
  }

  if (extracted.kind === "video_transcript") {
    const transcript = await db
      .from("learning_resources")
      .select("id")
      .eq("lesson_id", lesson.id)
      .eq("kind", "video_transcript")
      .eq("status", "ready")
      .limit(1);
    if (transcript.data?.length) {
      return failure(
        "transcript_exists",
        "This lesson already has an indexed transcript. Upload notes or slides instead.",
      );
    }
  }

  const resourceId = randomUUID();
  const extension = extensionOf(input.filename);
  const storagePath = `${input.userId}/${resourceId}${extension}`;
  const contentType = contentTypeFor(extension);
  const upload = await input.supabase.storage
    .from(RESOURCE_BUCKET)
    .upload(storagePath, input.bytes, { contentType, upsert: false });
  if (upload.error) {
    return failure(
      "storage_unavailable",
      "The private file store rejected this upload. Check that the storage migration is applied.",
    );
  }

  const rows: StoredChunkRow[] = extracted.chunks.map((chunk, index) =>
    chunkRow(resourceId, index, chunk),
  );
  const embedded = await embedChunks(extracted.chunks, rows);
  const embeddingStatus =
    embedded.embedded === extracted.chunks.length
      ? "complete"
      : embedded.embedded > 0
        ? "partial"
        : "unavailable";

  const insertedResource = await db.from("learning_resources").insert({
    id: resourceId,
    owner_id: input.userId,
    course_id: lesson.course_id,
    lesson_id: lesson.id,
    is_demo: false,
    kind: extracted.kind,
    title: extracted.title,
    status: "processing",
    source_url: null,
    content_hash: contentHash,
    metadata: {
      ...extracted.metadata,
      storage_bucket: RESOURCE_BUCKET,
      storage_path: storagePath,
      embedding_status: embeddingStatus,
      ...(embedded.error === undefined ? {} : { embedding_error: embedded.error }),
    },
  });
  if (insertedResource.error) {
    await input.supabase.storage.from(RESOURCE_BUCKET).remove([storagePath]);
    return failure(
      "database_unavailable",
      insertedResource.error.code === "23505"
        ? "This exact file is already indexed for this lesson."
        : "The resource record could not be created.",
    );
  }

  for (let start = 0; start < embedded.rows.length; start += INSERT_BATCH) {
    const batch = embedded.rows.slice(start, start + INSERT_BATCH);
    const inserted = await db.from("resource_chunks").insert(batch);
    if (inserted.error) {
      // Do not leave a half-indexed source or an orphaned private file behind.
      await input.supabase.storage.from(RESOURCE_BUCKET).remove([storagePath]);
      await db
        .from("learning_resources")
        .delete()
        .eq("id", resourceId)
        .eq("owner_id", input.userId);
      return failure("database_unavailable", "The indexed passages could not be saved.");
    }
  }

  const finalized = await db
    .from("learning_resources")
    .update({
      status: "ready",
      metadata: {
        ...extracted.metadata,
        storage_bucket: RESOURCE_BUCKET,
        storage_path: storagePath,
        embedding_status: embeddingStatus,
        embedded_chunks: embedded.embedded,
        ...(embedded.error === undefined ? {} : { embedding_error: embedded.error }),
      },
    })
    .eq("id", resourceId)
    .eq("owner_id", input.userId);
  if (finalized.error) {
    return failure("database_unavailable", "The resource was saved but could not be finalized.");
  }

  // An uploaded caption track is both citable evidence and the transcript shown
  // beside the player, so keep the lesson row in step. Retrieval already works
  // at this point, so a failure here is reported rather than undoing the upload.
  if (extracted.kind === "video_transcript") {
    try {
      const segments = parseCaptions(
        new TextDecoder("utf-8", { fatal: false }).decode(input.bytes),
      );
      const synced = await input.supabase
        .from("lessons")
        .update({ transcript: segments, transcript_status: "available" })
        .eq("id", lesson.id);
      if (synced.error) {
        console.error("[ingestion] transcript panel sync failed", {
          lessonId: lesson.id,
          code: synced.error.code,
        });
      }
    } catch (error) {
      console.error("[ingestion] transcript panel sync skipped", {
        lessonId: lesson.id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    status: "ready",
    resourceId,
    kind: extracted.kind,
    title: extracted.title,
    chunkCount: extracted.chunks.length,
    embeddedChunks: embedded.embedded,
    embeddingStatus,
  };
}
