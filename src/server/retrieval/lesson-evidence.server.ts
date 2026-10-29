import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { transcriptSegments, type TranscriptSegment } from "@/lib/learning";
import type { AiDatabase } from "./ai-database";
import type { EvidenceChunk, EvidenceLocator, ResourceKind } from "./types";

export type LessonRow = Database["public"]["Tables"]["lessons"]["Row"];
type AiClient = SupabaseClient<AiDatabase>;

interface ResourceRow {
  id: string;
  owner_id: string | null;
  course_id: string | null;
  lesson_id: string | null;
  is_demo: boolean;
  kind: ResourceKind;
  title: string;
  source_url: string | null;
  metadata: Record<string, unknown>;
}

const RESOURCE_BUCKET = "learning-resources";

/** Private uploads are opened through a short-lived signed URL, never a public path. */
async function signedSourceUrl(
  supabase: SupabaseClient<Database>,
  resource: ResourceRow,
): Promise<string | undefined> {
  if (resource.source_url) return resource.source_url;
  const storagePath = resource.metadata["storage_path"];
  if (typeof storagePath !== "string" || !storagePath) return undefined;
  const { data } = await supabase.storage.from(RESOURCE_BUCKET).createSignedUrl(storagePath, 3_600);
  return data?.signedUrl;
}

function parseStoredVector(value: unknown): number[] | undefined {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(parsed) || parsed.length !== 1_024) return undefined;
  return parsed.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (parsed as number[])
    : undefined;
}

function storedLocator(
  row: {
    locator_kind: "video" | "page" | "slide" | "text";
    video_start_seconds: number | null;
    video_end_seconds: number | null;
    page_number: number | null;
    slide_number: number | null;
    section: string | null;
  },
  lessonId: string,
): EvidenceLocator | undefined {
  if (row.locator_kind === "video") {
    if (row.video_start_seconds === null || row.video_end_seconds === null) return undefined;
    return {
      kind: "video",
      lessonId,
      startSeconds: row.video_start_seconds,
      endSeconds: row.video_end_seconds,
    };
  }
  if (row.locator_kind === "page") {
    return row.page_number !== null && Number.isInteger(row.page_number)
      ? { kind: "page", pageNumber: row.page_number }
      : undefined;
  }
  if (row.locator_kind === "slide") {
    return row.slide_number !== null && Number.isInteger(row.slide_number)
      ? { kind: "slide", slideNumber: row.slide_number }
      : undefined;
  }
  return { kind: "text", ...(row.section ? { section: row.section } : {}) };
}

async function loadResourceChunks(
  supabase: SupabaseClient<Database>,
  lesson: LessonRow,
): Promise<EvidenceChunk[]> {
  const db = supabase as unknown as AiClient;
  const resources: ResourceRow[] = [];

  const lessonScoped = await db
    .from("learning_resources")
    .select("id,owner_id,course_id,lesson_id,is_demo,kind,title,source_url,metadata")
    .eq("status", "ready")
    .eq("lesson_id", lesson.id);
  if (lessonScoped.error) {
    // The app remains usable before the additive migration is applied. A
    // missing relation is the only error we suppress; RLS/query failures are real.
    if (lessonScoped.error.code === "42P01") return [];
    throw lessonScoped.error;
  }
  resources.push(...(lessonScoped.data ?? []));

  if (lesson.course_id) {
    const courseScoped = await db
      .from("learning_resources")
      .select("id,owner_id,course_id,lesson_id,is_demo,kind,title,source_url,metadata")
      .eq("status", "ready")
      .eq("course_id", lesson.course_id)
      .is("lesson_id", null);
    if (courseScoped.error) {
      if (courseScoped.error.code === "42P01") return [];
      throw courseScoped.error;
    }
    resources.push(...(courseScoped.data ?? []));
  }

  const unique = new Map(resources.map((resource) => [resource.id, resource]));
  if (!unique.size) return [];
  const resourceById = unique;
  const sourceUrls = new Map(
    await Promise.all(
      [...unique.values()].map(
        async (resource) => [resource.id, await signedSourceUrl(supabase, resource)] as const,
      ),
    ),
  );
  const chunks = await db
    .from("resource_chunks")
    .select(
      "id,resource_id,chunk_index,heading,text,locator_kind,video_start_seconds,video_end_seconds,page_number,slide_number,section,embedding,embedding_space_key",
    )
    .in("resource_id", [...unique.keys()])
    .order("resource_id")
    .order("chunk_index");
  if (chunks.error) {
    if (chunks.error.code === "42P01") return [];
    throw chunks.error;
  }

  const result: EvidenceChunk[] = [];
  for (const row of chunks.data ?? []) {
    const resource = resourceById.get(row.resource_id);
    if (!resource) continue;
    const locator = storedLocator(row, resource.lesson_id ?? lesson.id);
    if (!locator) continue;
    const vector = parseStoredVector(row.embedding);
    result.push({
      id: row.id,
      resourceId: resource.id,
      resourceKind: resource.kind,
      isDemo: resource.is_demo,
      ownerId: resource.owner_id,
      ...(resource.course_id === null ? {} : { courseId: resource.course_id }),
      ...(resource.lesson_id === null ? {} : { lessonId: resource.lesson_id }),
      status: "ready",
      text: row.heading ? `${row.heading}\n${row.text}` : row.text,
      locator,
      provenance: {
        title: resource.title,
        ...(sourceUrls.get(resource.id) === undefined
          ? {}
          : { sourceUrl: sourceUrls.get(resource.id)! }),
      },
      ...(vector === undefined
        ? {}
        : {
            embedding: vector,
            ...(row.embedding_space_key === null
              ? {}
              : { embeddingSpaceKey: row.embedding_space_key }),
          }),
    });
  }
  return result;
}

export interface LoadedLesson {
  lesson: LessonRow;
  chunks: EvidenceChunk[];
}

const TARGET_CHUNK_CHARS = 700;
const MAX_CHUNK_CHARS = 1_500;
const MAX_MERGE_GAP_SECONDS = 6;
// A merged passage must become eligible early enough to answer a question about
// the part the learner has actually watched. One whole 50-minute transcript
// would be uselessly ineligible until the final second.
const MAX_MERGE_SPAN_SECONDS = 25;

function buildTranscriptChunks(lesson: LessonRow): EvidenceChunk[] {
  const segments = transcriptSegments(lesson.transcript);
  if (!segments.length) return [];

  const merged: TranscriptSegment[] = [];
  for (const segment of segments) {
    const current = merged.at(-1);
    const text = segment.heading ? `${segment.heading}\n${segment.text}` : segment.text;
    if (
      current &&
      current.text.length + text.length <= TARGET_CHUNK_CHARS &&
      segment.start - current.end <= MAX_MERGE_GAP_SECONDS &&
      segment.end - current.start <= MAX_MERGE_SPAN_SECONDS
    ) {
      current.end = segment.end;
      current.text = `${current.text} ${text}`.trim();
    } else {
      merged.push({ ...segment, text });
    }
  }

  return merged
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment, index) => {
      const text = segment.text.slice(0, MAX_CHUNK_CHARS);
      const start = Math.max(0, segment.start);
      const end = Math.min(segment.end, lesson.duration_seconds || segment.end);
      return {
        id: `transcript:${lesson.id}:${start.toFixed(3)}:${index}`,
        resourceId: `transcript:${lesson.id}`,
        resourceKind: "video_transcript" as const,
        isDemo: lesson.is_demo,
        ownerId: lesson.is_demo ? null : lesson.user_id,
        ...(lesson.course_id === null ? {} : { courseId: lesson.course_id }),
        lessonId: lesson.id,
        status: "ready" as const,
        text,
        locator: {
          kind: "video" as const,
          lessonId: lesson.id,
          startSeconds: start,
          endSeconds: end,
        },
        provenance: { title: lesson.title },
      };
    })
    .filter(
      (chunk) =>
        chunk.locator.kind === "video" &&
        chunk.locator.endSeconds > chunk.locator.startSeconds &&
        chunk.locator.endSeconds <= (lesson.duration_seconds || chunk.locator.endSeconds),
    );
}

/**
 * Loads the lesson through the caller's RLS-scoped Supabase client, then builds
 * evidence only from content that exists. This first slice uses the stored
 * transcript; the resource table will add PDFs, slides and notes without
 * changing the evidence contract.
 */
export async function loadLessonEvidence(
  supabase: SupabaseClient<Database>,
  lessonId: string,
): Promise<LoadedLesson | null> {
  const { data, error } = await supabase
    .from("lessons")
    .select("*")
    .eq("id", lessonId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const resources = await loadResourceChunks(supabase, data);
  // An ingested transcript is already chunked and contains stored embeddings.
  // Prefer it so the same passage is never indexed twice. The stored VTT on the
  // lesson remains the fallback for imported and not-yet-indexed lessons.
  const hasIndexedTranscript = resources.some(
    (chunk) => chunk.resourceKind === "video_transcript" && chunk.lessonId === data.id,
  );
  return {
    lesson: data,
    chunks: hasIndexedTranscript ? resources : [...buildTranscriptChunks(data), ...resources],
  };
}
