import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { transcriptSegments, type TranscriptSegment } from "@/lib/learning";
import { GEMINI_EMBEDDING_MODEL, GeminiEmbeddingProvider } from "../ai/embeddings/gemini";
import { isEmbeddingError } from "../ai/embeddings/errors";
import { embeddingSpaceFor, embeddingSpaceKey } from "../ai/embeddings/space";
import { getAiRuntime } from "../ai/runtime.server";
import type { EvidenceChunk, RetrievalStrategy } from "../retrieval/types";
import { chunkTranscript, type RagChunk } from "./chunking";
import type { RagChunkRow, RagDatabase } from "./database";

type RagClient = SupabaseClient<RagDatabase>;

export const RAG_EMBEDDING_SPACE = embeddingSpaceKey(embeddingSpaceFor(GEMINI_EMBEDDING_MODEL));

export interface RagLesson {
  id: string;
  title: string;
  user_id: string | null;
  course_id: string | null;
  is_demo: boolean;
  duration_seconds: number;
  transcript: unknown;
}

export interface VideoIndexResult {
  status: "ready" | "failed";
  chunks: number;
  skipped?: boolean;
  error?: string;
}

export type RagMode = "tutor" | "explain" | "summary" | "quiz";

export interface RagRetrieval {
  chunks: EvidenceChunk[];
  strategy: RetrievalStrategy;
  scores: Map<string, number>;
}

const EMBED_BATCH = 8;
const INSERT_BATCH = 24;
const MAX_QUERY_CACHE = 200;
const queryCache = new Map<string, number[]>();

function dbOf(supabase: SupabaseClient<Database>): RagClient {
  return supabase as unknown as RagClient;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceHash(chunks: RagChunk[]): string {
  const digest = createHash("sha256");
  digest.update(RAG_EMBEDDING_SPACE);
  for (const chunk of chunks) {
    digest.update(
      `\0${chunk.startSeconds.toFixed(3)}:${chunk.endSeconds.toFixed(3)}:${chunk.text}`,
    );
  }
  return digest.digest("hex");
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function markIndex(
  db: RagClient,
  lessonId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const result = await db.from("video_indexes").upsert(
    {
      lesson_id: lessonId,
      embedding_provider: GEMINI_EMBEDDING_MODEL.providerId,
      embedding_model: GEMINI_EMBEDDING_MODEL.modelId,
      embedding_dimension: GEMINI_EMBEDDING_MODEL.dimension,
      embedding_space_key: RAG_EMBEDDING_SPACE,
      ...patch,
    },
    { onConflict: "lesson_id" },
  );
  if (result.error) {
    console.error("[rag] index state could not be saved", {
      lessonId,
      code: result.error.code,
    });
  }
}

async function embedDocuments(chunks: RagChunk[]): Promise<number[][]> {
  const provider = new GeminiEmbeddingProvider();
  if (!provider.isConfigured()) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  const vectors: number[][] = [];
  for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
    const batch = chunks.slice(start, start + EMBED_BATCH);
    let attempt = 0;
    for (;;) {
      try {
        const output = await provider.embed(
          batch.map((chunk) => chunk.text),
          GEMINI_EMBEDDING_MODEL,
          {
            purpose: "document",
            correlationId: `rag-index-${start}`,
          },
        );
        for (const vector of output.vectors) {
          if (vector.length !== GEMINI_EMBEDDING_MODEL.dimension) {
            throw new Error(
              `Embedding dimension ${vector.length} does not match ${GEMINI_EMBEDDING_MODEL.dimension}.`,
            );
          }
        }
        vectors.push(...output.vectors);
        break;
      } catch (error) {
        const retryable =
          isEmbeddingError(error) &&
          (error.code === "rate_limited" || error.code === "provider_unavailable");
        if (!retryable || attempt >= 6) throw error;
        const delay = isEmbeddingError(error)
          ? Math.min(error.retryAfterMs ?? 10_000 * 2 ** attempt, 60_000)
          : 10_000 * 2 ** attempt;
        console.warn("[rag] embedding retry", {
          attempt: attempt + 1,
          delayMs: delay,
          reason: error instanceof Error ? error.message.slice(0, 240) : "unknown",
        });
        await sleep(delay);
        attempt += 1;
      }
    }
    // Stay under the embedding provider's per-minute token budget. A failed
    // batch is retried above, so this pacing only reduces avoidable 429s.
    if (start + EMBED_BATCH < chunks.length) await sleep(5_000);
  }
  return vectors;
}

/**
 * Indexes one lesson's timestamped transcript into `video_chunks` with Gemini
 * embeddings. Idempotent: the source hash is stored, duplicate chunk indexes
 * are upserted, stale chunks are removed, and a failed run never reports ready.
 */
export async function indexLessonVideo(input: {
  supabase: SupabaseClient<Database>;
  lesson: RagLesson;
  segments?: TranscriptSegment[];
  force?: boolean;
}): Promise<VideoIndexResult> {
  const db = dbOf(input.supabase);
  const lessonId = input.lesson.id;
  try {
    const segments =
      input.segments ??
      transcriptSegments(input.lesson.transcript).map((segment) => ({
        ...segment,
        end:
          input.lesson.duration_seconds > 0
            ? Math.min(segment.end, input.lesson.duration_seconds)
            : segment.end,
      }));
    if (!segments.length) {
      await markIndex(db, lessonId, {
        status: "failed",
        error: "This lesson has no timestamped transcript to index.",
        chunk_count: 0,
      });
      return { status: "failed", chunks: 0, error: "no_transcript" };
    }

    const chunks = chunkTranscript(segments);
    if (!chunks.length) {
      await markIndex(db, lessonId, {
        status: "failed",
        error: "The transcript produced no usable passages.",
        chunk_count: 0,
      });
      return { status: "failed", chunks: 0, error: "empty_transcript" };
    }

    const sourceDigest = sourceHash(chunks);
    const existing = await db
      .from("video_indexes")
      .select("status,source_hash,chunk_count")
      .eq("lesson_id", lessonId)
      .maybeSingle();
    if (existing.error && existing.error.code !== "42P01" && existing.error.code !== "PGRST205") {
      throw new Error(`Index state could not be read (${existing.error.code}).`);
    }
    if (
      !input.force &&
      existing.data?.status === "ready" &&
      existing.data.source_hash === sourceDigest &&
      existing.data.chunk_count === chunks.length
    ) {
      return { status: "ready", chunks: chunks.length, skipped: true };
    }

    await markIndex(db, lessonId, {
      status: "processing",
      error: null,
      source_hash: sourceDigest,
      chunk_count: 0,
    });

    let vectors: number[][];
    try {
      vectors = await embedDocuments(chunks);
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 300) : "Embedding generation failed.";
      await markIndex(db, lessonId, {
        status: "failed",
        error: message,
        source_hash: sourceDigest,
      });
      console.error("[rag] embedding failed", { lessonId, reason: message });
      return { status: "failed", chunks: 0, error: "embedding_failed" };
    }

    if (vectors.length !== chunks.length) {
      await markIndex(db, lessonId, {
        status: "failed",
        error: "The embedding provider returned the wrong number of vectors.",
        source_hash: sourceDigest,
      });
      return { status: "failed", chunks: 0, error: "embedding_count_mismatch" };
    }

    const rows = chunks.map((chunk, index) => ({
      lesson_id: lessonId,
      chunk_index: chunk.index,
      text: chunk.text,
      start_seconds: Math.max(0, chunk.startSeconds),
      end_seconds: Math.max(chunk.startSeconds + 0.05, chunk.endSeconds),
      embedding: vectorLiteral(vectors[index]!),
      embedding_provider: GEMINI_EMBEDDING_MODEL.providerId,
      embedding_model: GEMINI_EMBEDDING_MODEL.modelId,
      embedding_dimension: GEMINI_EMBEDDING_MODEL.dimension,
      embedding_space_key: RAG_EMBEDDING_SPACE,
      content_hash: hash(chunk.text),
      metadata: { word_count: chunk.wordCount, source: "transcript" },
    }));

    for (let start = 0; start < rows.length; start += INSERT_BATCH) {
      const batch = rows.slice(start, start + INSERT_BATCH);
      const inserted = await db
        .from("video_chunks")
        .upsert(batch, { onConflict: "lesson_id,chunk_index" });
      if (inserted.error) {
        // Never leave a half-inserted index that could be mistaken for ready.
        await db.from("video_chunks").delete().eq("lesson_id", lessonId);
        await markIndex(db, lessonId, {
          status: "failed",
          error: `Vector rows could not be saved (${inserted.error.code}).`,
          source_hash: sourceDigest,
        });
        console.error("[rag] chunk insert failed", {
          lessonId,
          code: inserted.error.code,
          batchSize: batch.length,
        });
        return { status: "failed", chunks: 0, error: "database_unavailable" };
      }
    }

    await db
      .from("video_chunks")
      .delete()
      .eq("lesson_id", lessonId)
      .gte("chunk_index", rows.length);

    await markIndex(db, lessonId, {
      status: "ready",
      error: null,
      chunk_count: rows.length,
      source_hash: sourceDigest,
      indexed_at: new Date().toISOString(),
    });
    return { status: "ready", chunks: rows.length };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "Indexing failed.";
    await markIndex(db, lessonId, { status: "failed", error: message });
    console.error("[rag] indexing failed", { lessonId, reason: message });
    return { status: "failed", chunks: 0, error: "indexing_failed" };
  }
}

async function embedQuery(text: string): Promise<number[] | null> {
  const key = `${RAG_EMBEDDING_SPACE}:${hash(text)}`;
  const cached = queryCache.get(key);
  if (cached) return cached;
  try {
    const result = await getAiRuntime().embeddings.embed({
      providerId: GEMINI_EMBEDDING_MODEL.providerId,
      modelId: GEMINI_EMBEDDING_MODEL.modelId,
      inputs: [text],
      purpose: "query",
      timeoutMs: 20_000,
    });
    const vector = result.vectors[0];
    if (!vector || vector.length !== GEMINI_EMBEDDING_MODEL.dimension) return null;
    if (queryCache.size >= MAX_QUERY_CACHE) {
      const oldest = queryCache.keys().next().value;
      if (oldest !== undefined) queryCache.delete(oldest);
    }
    queryCache.set(key, vector);
    return vector;
  } catch (error) {
    console.warn("[rag] query embedding unavailable", {
      code: isEmbeddingError(error) ? error.code : "unknown",
    });
    return null;
  }
}

function toEvidence(lesson: RagLesson, row: RagChunkRow): EvidenceChunk | null {
  if (!Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds)) return null;
  if (row.end_seconds <= row.start_seconds || !row.text.trim()) return null;
  const end = Math.min(
    row.end_seconds,
    lesson.duration_seconds > 0 ? lesson.duration_seconds : row.end_seconds,
  );
  if (end <= row.start_seconds) return null;
  return {
    id: row.id,
    resourceId: `video-index:${lesson.id}`,
    resourceKind: "video_transcript",
    isDemo: lesson.is_demo,
    ownerId: lesson.is_demo ? null : lesson.user_id,
    ...(lesson.course_id === null ? {} : { courseId: lesson.course_id }),
    lessonId: lesson.id,
    status: "ready",
    text: row.text,
    locator: {
      kind: "video",
      lessonId: lesson.id,
      startSeconds: Math.max(0, row.start_seconds),
      endSeconds: end,
    },
    provenance: { title: lesson.title },
    availability: "timeline",
  };
}

function rowsToRetrieval(
  lesson: RagLesson,
  rows: RagChunkRow[],
  strategy: RetrievalStrategy,
): RagRetrieval {
  const chunks: EvidenceChunk[] = [];
  const scores = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const evidence = toEvidence(lesson, row);
    if (!evidence) continue;
    seen.add(row.id);
    chunks.push(evidence);
    scores.set(row.id, row.similarity ?? 0);
  }
  return { chunks, strategy, scores };
}

/**
 * Retrieves only chunks from this lesson that end before the learner's current
 * playback position. The filter runs inside the security-invoker SQL function,
 * so it cannot be widened by a client value or prompt. Returns null only when
 * the lesson has no ready vector index (callers may then use the legacy path).
 */
export async function retrieveVideoEvidence(input: {
  supabase: SupabaseClient<Database>;
  lesson: RagLesson;
  positionSeconds: number;
  query: string;
  mode: RagMode;
  limit?: number;
}): Promise<RagRetrieval | null> {
  const position = input.positionSeconds;
  if (!Number.isFinite(position) || position < 0) return null;
  const db = dbOf(input.supabase);

  const indexed = await db
    .from("video_indexes")
    .select("status,chunk_count")
    .eq("lesson_id", input.lesson.id)
    .maybeSingle();
  if (indexed.error) {
    if (!["42P01", "PGRST205"].includes(indexed.error.code)) {
      console.warn("[rag] index lookup failed", { code: indexed.error.code });
    }
    return null;
  }
  if (indexed.data?.status !== "ready" || (indexed.data.chunk_count ?? 0) < 1) return null;

  const limit = Math.min(Math.max(1, input.limit ?? 8), 20);

  if (input.mode === "summary") {
    const covered = await db.rpc("list_covered_video_chunks", {
      target_lesson_id: input.lesson.id,
      max_position_seconds: position,
      match_count: Math.min(limit + 4, 20),
    });
    if (covered.error) {
      console.warn("[rag] chronological retrieval failed", { code: covered.error.code });
      return null;
    }
    // Keep the latest covered passages, returned in chronological order so the
    // summary prompt reads naturally and never includes future material.
    const rows = (covered.data ?? [])
      .slice()
      .sort((a, b) => a.start_seconds - b.start_seconds)
      .slice(-limit);
    return rowsToRetrieval(input.lesson, rows, "summary");
  }

  const query =
    input.mode === "explain"
      ? `Explain the idea being taught here: ${input.query || input.lesson.title}`
      : input.mode === "quiz"
        ? `Key concepts, definitions and examples from ${input.lesson.title}. ${input.query}`
        : input.query;
  const vector = await embedQuery(query.trim() || input.lesson.title);
  if (!vector) return null;

  const matched = await db.rpc("match_video_chunks", {
    query_embedding: vectorLiteral(vector),
    target_lesson_id: input.lesson.id,
    max_position_seconds: position,
    match_count: limit,
  });
  if (matched.error) {
    console.warn("[rag] similarity retrieval failed", { code: matched.error.code });
    return null;
  }

  let rows = matched.data ?? [];
  if (input.mode === "explain") {
    // Add the passages immediately before the playhead so "explain simply"
    // always has local context, not only semantically similar later material.
    const recent = await db.rpc("list_covered_video_chunks", {
      target_lesson_id: input.lesson.id,
      max_position_seconds: position,
      match_count: 3,
    });
    if (!recent.error && recent.data?.length) {
      const seen = new Set(rows.map((row) => row.id));
      rows = [...recent.data.filter((row) => !seen.has(row.id)), ...rows];
    }
    rows.sort((a, b) => a.start_seconds - b.start_seconds);
  }
  return rowsToRetrieval(input.lesson, rows, "semantic");
}
