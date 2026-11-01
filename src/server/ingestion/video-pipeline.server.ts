import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { IngestionState, IngestionStatus } from "@/lib/ingestion-types";
import { parseCaptions, transcriptSegments, type TranscriptSegment } from "@/lib/learning";
import {
  buildTranscriptCues,
  buildTranscriptVtt,
  getMediaFile,
  isTranscriptionError,
  mediaMimeTypeFor,
  transcribeMediaFile,
  TranscriptionError,
  startMediaUpload,
  transcriptionConfigured,
  transcriptionModel,
  uploadMediaChunk,
  MEDIA_CHUNK_BYTES,
  type TranscriptSegment as ProviderSegment,
} from "@/server/ai/transcription/gemini.server";
import { ingestLessonResource } from "./service.server";
import { indexLessonVideo } from "../rag/service.server";

type JobRow = Database["public"]["Tables"]["video_ingestion_jobs"]["Row"];
type JobUpdate = Database["public"]["Tables"]["video_ingestion_jobs"]["Update"];

/** jsonb columns accept plain JSON; domain objects are narrowed at the boundary. */
function asJson(value: unknown): JobRow["progress"] {
  return value as JobRow["progress"];
}
type LessonRow = Database["public"]["Tables"]["lessons"]["Row"];
type AiDb = SupabaseClient<Database>;

export type VideoSourceKind = "upload" | "youtube" | "vimeo" | "direct";

export type { IngestionState, IngestionStatus };

export interface IngestionJobProgress {
  stage?: string;
  engine?: string;
  uploadUrl?: string;
  uploadedBytes?: number;
  totalBytes?: number;
  mimeType?: string;
  fileUri?: string;
  fileName?: string;
  providerModel?: string;
  segmentCount?: number;
  cueCount?: number;
  retryAt?: string;
  leaseUntil?: string;
  sourceKind?: string;
  resourceId?: string;
}

/** The provider transcript is parked in `progress` until the indexing step. */
type StoredProgress = IngestionJobProgress & { segments?: ProviderSegment[] };

const VIDEO_BUCKET = "lesson-videos";
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
const MAX_STEPS_PER_CALL = 24;
const STEP_BUDGET_MS = 45_000;
const RETRY_BACKOFF_MS = [8_000, 30_000, 90_000];

/**
 * Jobs are keyed by lesson and by the exact video reference, so replacing a
 * video starts a fresh job instead of inheriting the previous transcript state.
 */
export function videoSourceKind(videoUrl: string): VideoSourceKind | null {
  const url = videoUrl.trim();
  if (url.startsWith(`storage://${VIDEO_BUCKET}/`)) return "upload";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    return "youtube";
  }
  if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) return "vimeo";
  if (/\.(mp4|webm)$/i.test(parsed.pathname)) return "direct";
  return null;
}

/** True when the learner is allowed to download this source from the server. */
function isPublicHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false;
  if (["localhost", "metadata.google.internal"].includes(host)) return false;
  return true;
}

function youtubeId(videoUrl: string): string | null {
  const url = new URL(videoUrl);
  const id =
    url.hostname.toLowerCase() === "youtu.be"
      ? url.pathname.slice(1)
      : url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

function vimeoId(videoUrl: string): string | null {
  const url = new URL(videoUrl);
  return url.pathname.match(/\/(?:video\/)?(\d+)$/)?.[1] ?? null;
}

class CaptionUnavailable extends Error {}

async function fetchText(url: string, limitBytes: number, timeoutMs = 20_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new CaptionUnavailable(`The host returned HTTP ${response.status}.`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw new CaptionUnavailable("The caption track is larger than expected.");
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  } catch (error) {
    if (error instanceof CaptionUnavailable) throw error;
    throw new CaptionUnavailable("The caption track could not be downloaded.");
  } finally {
    clearTimeout(timer);
  }
}

function youtubeCaptionTracks(page: string): Array<Record<string, unknown>> {
  const match = page.match(/"captionTracks":(\[[\s\S]*?\])(?=,")/);
  if (!match?.[1]) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return Array.isArray(parsed)
      ? parsed.filter(
          (track): track is Record<string, unknown> => typeof track === "object" && track !== null,
        )
      : [];
  } catch {
    return [];
  }
}

export function parseYoutubeCaptionEvents(body: string): ProviderSegment[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof payload !== "object" || payload === null) return [];
  const events = Array.isArray((payload as Record<string, unknown>)["events"])
    ? ((payload as Record<string, unknown>)["events"] as unknown[])
    : [];
  const segments: ProviderSegment[] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const row = event as Record<string, unknown>;
    const startMs = Number(row["tStartMs"]);
    const durationMs = Number(row["dDurationMs"]);
    const parts = Array.isArray(row["segs"]) ? row["segs"] : [];
    const text = parts
      .map((part) =>
        typeof part === "object" && part !== null
          ? String((part as Record<string, unknown>)["utf8"] ?? "")
          : "",
      )
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || !Number.isFinite(startMs) || !Number.isFinite(durationMs)) continue;
    const start = startMs / 1_000;
    const end = (startMs + durationMs) / 1_000;
    if (end <= start) continue;
    segments.push({ start, end, text });
  }
  return segments;
}

function mergeProviderSegments(segments: ProviderSegment[]): TranscriptSegment[] {
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  const merged: ProviderSegment[] = [];
  for (const segment of ordered) {
    const current = merged.at(-1);
    if (current && segment.start < current.end) continue;
    if (
      current &&
      segment.start - current.end <= 2 &&
      segment.end - current.start <= 18 &&
      current.text.length + segment.text.length < 900
    ) {
      current.end = segment.end;
      current.text = `${current.text} ${segment.text}`;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged
    .map((segment) => ({
      start: Number(segment.start.toFixed(3)),
      end: Number(segment.end.toFixed(3)),
      text: segment.text,
    }))
    .filter((segment) => segment.text && segment.end > segment.start);
}

/**
 * Reads a host's published caption track. This is a convenience path: a host
 * may not publish captions, may sign them for a browser session only, or may
 * refuse the request. Every failure is reported as "captions unavailable" and
 * never replaced with invented text.
 */
export async function fetchLinkCaptions(
  kind: "youtube" | "vimeo",
  videoUrl: string,
): Promise<TranscriptSegment[]> {
  if (kind === "youtube") {
    const id = youtubeId(videoUrl);
    if (!id) throw new CaptionUnavailable("This YouTube link does not identify a video.");
    const page = await fetchText(`https://www.youtube.com/watch?v=${id}&hl=en`, 4_000_000);
    const tracks = youtubeCaptionTracks(page);
    if (!tracks.length) throw new CaptionUnavailable("This video has no published caption track.");
    const track =
      tracks.find((item) => item["languageCode"] === "en" && item["kind"] !== "asr") ??
      tracks.find((item) => item["languageCode"] === "en") ??
      tracks[0];
    const baseUrl = typeof track?.["baseUrl"] === "string" ? track["baseUrl"] : "";
    if (!baseUrl) throw new CaptionUnavailable("The caption track has no readable address.");
    const body = await fetchText(`${baseUrl}&fmt=json3`, 8_000_000);
    const segments = mergeProviderSegments(parseYoutubeCaptionEvents(body));
    if (!segments.length) throw new CaptionUnavailable("The published caption track is empty.");
    return segments;
  }

  const id = vimeoId(videoUrl);
  if (!id) throw new CaptionUnavailable("This Vimeo link does not identify a video.");
  const config = await fetchText(`https://player.vimeo.com/video/${id}/config`, 4_000_000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new CaptionUnavailable("The host did not expose a readable caption list.");
  }
  const request = (parsed as Record<string, unknown>)?.["request"];
  const tracks = Array.isArray((request as Record<string, unknown>)?.["text_tracks"])
    ? ((request as Record<string, unknown>)["text_tracks"] as unknown[])
    : [];
  const track =
    tracks.find((item) => {
      if (typeof item !== "object" || item === null) return false;
      const lang = String((item as Record<string, unknown>)["lang"] ?? "");
      return lang.toLowerCase().startsWith("en");
    }) ?? tracks[0];
  const trackUrl =
    typeof track === "object" && track !== null
      ? String((track as Record<string, unknown>)["url"] ?? "")
      : "";
  if (!trackUrl) throw new CaptionUnavailable("This video has no published caption track.");
  const body = await fetchText(trackUrl, 8_000_000);
  const segments = parseCaptions(body);
  if (!segments.length) throw new CaptionUnavailable("The published caption track is empty.");
  return segments;
}

interface MediaStorage {
  bucket: string;
  path: string;
}

function uploadStorageOf(videoUrl: string, userId: string): MediaStorage | null {
  const prefix = `storage://${VIDEO_BUCKET}/`;
  if (!videoUrl.startsWith(prefix)) return null;
  const path = videoUrl.slice(prefix.length);
  if (!path.startsWith(`${userId}/`) || path.includes("..") || path.includes("\\")) return null;
  return { bucket: VIDEO_BUCKET, path };
}

async function signedMediaUrl(
  supabase: SupabaseClient<Database>,
  bucket: string,
  path: string,
): Promise<string> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3_600);
  if (error || !data?.signedUrl)
    throw new CaptionUnavailable("The private video could not be read.");
  return data.signedUrl;
}

interface MediaReader {
  totalBytes: number;
  mimeType: string;
  read: (offset: number, length: number) => Promise<Uint8Array>;
}

async function storageReader(
  supabase: SupabaseClient<Database>,
  videoUrl: string,
  userId: string,
): Promise<MediaReader> {
  const storage = uploadStorageOf(videoUrl, userId);
  if (!storage) throw new CaptionUnavailable("The private video reference is invalid.");
  const mimeType = mediaMimeTypeFor(storage.path);
  if (!mimeType) throw new CaptionUnavailable("Only MP4 and WebM uploads can be transcribed.");
  const signedUrl = await signedMediaUrl(supabase, storage.bucket, storage.path);
  const head = await fetch(signedUrl, { headers: { Range: "bytes=0-0" } });
  if (!head.ok) throw new CaptionUnavailable("The private video could not be read.");
  const total = Number(head.headers.get("content-range")?.split("/")[1] ?? "0");
  await head.body?.cancel();
  if (!Number.isFinite(total) || total <= 0) {
    throw new CaptionUnavailable("The private video size could not be read.");
  }
  if (total > MAX_MEDIA_BYTES) throw new CaptionUnavailable("Videos must be 200 MB or smaller.");
  return {
    totalBytes: total,
    mimeType,
    read: async (offset, length) => {
      const response = await fetch(signedUrl, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new CaptionUnavailable("The stored video could not be read in pieces.");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

async function httpReader(videoUrl: string): Promise<MediaReader> {
  if (!isPublicHttpUrl(videoUrl)) {
    throw new CaptionUnavailable("Only public HTTPS media links can be processed automatically.");
  }
  const mimeType = mediaMimeTypeFor(new URL(videoUrl).pathname);
  if (!mimeType) throw new CaptionUnavailable("Only MP4 and WebM links can be transcribed.");
  const probe = await fetch(videoUrl, { method: "GET", headers: { Range: "bytes=0-0" } });
  if (!probe.ok) throw new CaptionUnavailable("The linked video could not be downloaded.");
  const contentType = probe.headers.get("content-type") ?? "";
  const total = Number(probe.headers.get("content-range")?.split("/")[1] ?? "0");
  await probe.body?.cancel();
  if (!Number.isFinite(total) || total <= 0) {
    throw new CaptionUnavailable("This link does not report a downloadable media size.");
  }
  if (total > MAX_MEDIA_BYTES) throw new CaptionUnavailable("Videos must be 200 MB or smaller.");
  if (!/^(video|audio)\//i.test(contentType)) {
    throw new CaptionUnavailable("This link does not serve a video file.");
  }
  return {
    totalBytes: total,
    mimeType,
    read: async (offset, length) => {
      const response = await fetch(videoUrl, {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      });
      if (response.status !== 206) {
        await response.body?.cancel();
        throw new CaptionUnavailable("This host does not support partial downloads.");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

function progressOf(job: JobRow): IngestionJobProgress {
  return (job.progress ?? {}) as IngestionJobProgress;
}

function stageLabel(status: string, progress: IngestionJobProgress): string {
  if (status === "queued") return "Queued";
  if (status === "preparing") {
    if (progress.stage === "uploading") return "Uploading media";
    if (progress.stage === "reading-captions") return "Reading published captions";
    return "Preparing media";
  }
  if (status === "transcribing") return "Transcribing audio";
  if (status === "indexing") return "Indexing transcript";
  return "Processing";
}

function statusView(
  lessonId: string,
  job: JobRow | null,
  transcriptReady: boolean,
): IngestionStatus {
  if (!job) {
    return transcriptReady
      ? {
          lessonId,
          state: "ready",
          stage: "Ready",
          message: "This video already has an indexed transcript.",
          canRetry: false,
        }
      : {
          lessonId,
          state: "none",
          stage: "Not processed",
          message: "This video has not been processed for timestamped questions yet.",
          canRetry: true,
        };
  }
  const progress = progressOf(job);
  if (job.status === "ready") {
    const parts = progress.segmentCount ? `${progress.segmentCount} passages` : "transcript";
    return {
      lessonId,
      state: "ready",
      stage: "Ready",
      message: `Processed and indexed (${parts}). You can ask at any timestamp you have reached.`,
      canRetry: false,
    };
  }
  if (job.status === "needs_captions") {
    return {
      lessonId,
      state: "needs_captions",
      stage: "Captions required",
      message:
        job.error_message ??
        "This host did not publish a caption track Horizon can read. Upload the video file for automatic transcription, or paste captions.",
      canRetry: true,
      ...(job.error_code ? { errorCode: job.error_code } : {}),
    };
  }
  if (job.status === "failed") {
    return {
      lessonId,
      state: "failed",
      stage: "Processing failed",
      message:
        job.error_message ??
        "Automatic transcript processing failed. You can retry, upload captions, or upload the video file.",
      canRetry: true,
      ...(job.error_code ? { errorCode: job.error_code } : {}),
    };
  }
  const percent =
    job.status === "preparing" &&
    typeof progress.totalBytes === "number" &&
    progress.totalBytes > 0 &&
    typeof progress.uploadedBytes === "number"
      ? Math.min(99, Math.round((progress.uploadedBytes / progress.totalBytes) * 100))
      : undefined;
  return {
    lessonId,
    state: job.status === "queued" ? "queued" : "processing",
    stage: stageLabel(job.status, progress),
    message:
      job.status === "transcribing"
        ? "The transcript is being generated. This panel and the tutor update automatically."
        : job.status === "indexing"
          ? "The transcript is being chunked and embedded for retrieval."
          : "Horizon is preparing this video for timestamped questions.",
    canRetry: true,
    pollAfterMs: job.status === "indexing" ? 1_500 : job.status === "transcribing" ? 3_000 : 1_200,
    ...(percent === undefined ? {} : { percent }),
  };
}

async function loadLesson(
  supabase: SupabaseClient<Database>,
  lessonId: string,
  userId: string,
): Promise<LessonRow | null> {
  const { data, error } = await supabase
    .from("lessons")
    .select("*")
    .eq("id", lessonId)
    .maybeSingle();
  if (error || !data) return null;
  if (!data.is_demo && data.user_id !== userId) return null;
  return data;
}

async function hasIndexedTranscript(
  supabase: SupabaseClient<Database>,
  lesson: LessonRow,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("learning_resources")
    .select("id")
    .eq("lesson_id", lesson.id)
    .eq("kind", "video_transcript")
    .eq("status", "ready")
    .limit(1);
  if (error && error.code !== "42P01") throw error;
  if (data?.length) return true;
  return lesson.transcript_status === "available" && Array.isArray(lesson.transcript)
    ? lesson.transcript.length > 0
    : false;
}

async function loadJob(
  supabase: SupabaseClient<Database>,
  lessonId: string,
  sourceUrl: string,
  userId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("video_ingestion_jobs")
    .select("*")
    .eq("lesson_id", lessonId)
    .eq("source_url", sourceUrl)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    if (error.code === "42P01") return null;
    throw error;
  }
  return data;
}

async function updateJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  patch: JobUpdate,
): Promise<void> {
  const { error } = await supabase.from("video_ingestion_jobs").update(patch).eq("id", jobId);
  if (error) throw new Error(`The ingestion job could not be updated (${error.code}).`);
}

/**
 * Optimistic lease: only the caller holding the current `updated_at` may take
 * the next step. Returns null when another request already advanced the job.
 */
async function leaseStep(supabase: SupabaseClient<Database>, job: JobRow): Promise<JobRow | null> {
  const progress = {
    ...progressOf(job),
    leaseUntil: new Date(Date.now() + 90_000).toISOString(),
  };
  const { data, error } = await supabase
    .from("video_ingestion_jobs")
    .update({ progress })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("*")
    .maybeSingle();
  if (error) return null;
  return data ?? null;
}

export async function getIngestionStatus(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lessonId: string;
}): Promise<IngestionStatus> {
  const lesson = await loadLesson(input.supabase, input.lessonId, input.userId);
  if (!lesson) {
    return {
      lessonId: input.lessonId,
      state: "failed",
      stage: "Unavailable",
      message: "That lesson is unavailable or you do not have access.",
      canRetry: false,
    };
  }
  const ready = await hasIndexedTranscript(input.supabase, lesson);
  if (lesson.is_demo) return statusView(lesson.id, null, true);
  const job = await loadJob(input.supabase, lesson.id, lesson.video_url, input.userId);
  return statusView(lesson.id, job, ready);
}

/**
 * Ensures a job exists for the lesson's current video, then advances it until a
 * step has to wait (provider work, retry backoff) or the call budget is spent.
 */
export async function advanceIngestion(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lessonId: string;
  /** Restart a failed or caption-blocked job. */
  retry?: boolean;
  deadlineMs?: number;
}): Promise<IngestionStatus> {
  const lesson = await loadLesson(input.supabase, input.lessonId, input.userId);
  if (!lesson) {
    return {
      lessonId: input.lessonId,
      state: "failed",
      stage: "Unavailable",
      message: "That lesson is unavailable or you do not have access.",
      canRetry: false,
    };
  }
  if (lesson.is_demo) return statusView(lesson.id, null, true);

  const ready = await hasIndexedTranscript(input.supabase, lesson);
  if (ready) {
    const existing = await loadJob(input.supabase, lesson.id, lesson.video_url, input.userId);
    if (existing && existing.status !== "ready") {
      await updateJob(input.supabase, existing.id, {
        status: "ready",
        progress: { ...progressOf(existing), stage: "ready" },
        error_code: null,
        error_message: null,
      }).catch(() => null);
    }
    return statusView(lesson.id, null, true);
  }

  const kind = videoSourceKind(lesson.video_url);
  if (!kind) {
    return {
      lessonId: lesson.id,
      state: "needs_captions",
      stage: "Captions required",
      message:
        "This video source cannot be transcribed automatically. Upload the MP4/WebM file or paste timestamped captions.",
      canRetry: false,
    };
  }
  if (!transcriptionConfigured() && (kind === "upload" || kind === "direct")) {
    return {
      lessonId: lesson.id,
      state: "failed",
      stage: "Transcription unavailable",
      message:
        "Automatic transcription is not configured on this server (GEMINI_API_KEY). You can still paste captions.",
      canRetry: false,
    };
  }

  let job = await loadJob(input.supabase, lesson.id, lesson.video_url, input.userId);
  if (!job) {
    const { data, error } = await input.supabase
      .from("video_ingestion_jobs")
      .insert({
        user_id: input.userId,
        lesson_id: lesson.id,
        source_url: lesson.video_url,
        source_kind: kind,
        status: "queued",
        // Rate limits and provider hiccups are expected on free tiers; a few
        // backed-off attempts recover without failing the learner's video.
        max_attempts: 5,
        progress: { stage: "queued", sourceKind: kind },
      })
      .select("*")
      .single();
    if (error || !data) {
      return {
        lessonId: lesson.id,
        state: "failed",
        stage: "Processing unavailable",
        message:
          "The processing job could not be created. Apply the video ingestion migration and try again.",
        canRetry: true,
      };
    }
    job = data;
  }

  if (input.retry && ["failed", "needs_captions", "ready"].includes(job.status)) {
    await updateJob(input.supabase, job.id, {
      status: "queued",
      attempt_count: 0,
      progress: { stage: "queued", sourceKind: kind },
      error_code: null,
      error_message: null,
    });
    job = {
      ...job,
      status: "queued",
      attempt_count: 0,
      progress: { stage: "queued" },
      error_code: null,
      error_message: null,
    };
  }

  const deadline =
    Date.now() + Math.max(5_000, Math.min(input.deadlineMs ?? STEP_BUDGET_MS, 120_000));
  let steps = 0;
  while (steps < MAX_STEPS_PER_CALL && Date.now() < deadline) {
    steps += 1;
    const progress = progressOf(job);
    if (progress.retryAt && Date.parse(progress.retryAt) > Date.now()) {
      break;
    }
    if (job.status === "ready" || job.status === "failed" || job.status === "needs_captions") {
      break;
    }
    // Two tabs (or a reload racing a slow request) must not both upload the same
    // media. The conditional update acts as a short lease on the row.
    const leased = await leaseStep(input.supabase, job);
    if (!leased) {
      const fresh = await loadJob(input.supabase, lesson.id, lesson.video_url, input.userId);
      return statusView(lesson.id, fresh, false);
    }
    job = leased;
    try {
      const next = await runStep({
        supabase: input.supabase,
        userId: input.userId,
        lesson,
        job,
        kind,
      });
      const { data, error } = await input.supabase
        .from("video_ingestion_jobs")
        .update(next.patch)
        .eq("id", job.id)
        .select("*")
        .single();
      if (error || !data) throw new Error("The ingestion job could not be saved.");
      job = data;
      if (!next.continue) break;
    } catch (error) {
      const failed = await recordFailure(input.supabase, job, error);
      job = failed;
      break;
    }
  }

  return statusView(lesson.id, job, false);
}

async function recordFailure(
  supabase: SupabaseClient<Database>,
  job: JobRow,
  error: unknown,
): Promise<JobRow> {
  const known = isTranscriptionError(error);
  const noSpeech = known && error.code === "transcript_empty";
  // Caption and no-speech outcomes are not transient: retrying the same media
  // cannot invent speech, so they stop immediately with an actionable message.
  const caption = error instanceof CaptionUnavailable || noSpeech;
  const attempts = job.attempt_count + 1;
  const retryable = caption ? false : known ? error.retryable : false;
  const maxAttempts = job.max_attempts;
  const exhausted = !retryable || attempts >= maxAttempts;
  const providerDelay = known && error.retryable ? error.retryAfterMs : undefined;
  const backoff = Math.min(
    180_000,
    Math.max(
      providerDelay ?? 0,
      RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)] ?? 30_000,
    ),
  );
  const message = (error instanceof Error ? error.message : "Processing failed.").slice(0, 300);
  const progress = progressOf(job);
  const patch: JobUpdate = {
    attempt_count: attempts,
    error_code: noSpeech
      ? "no_speech"
      : caption
        ? "captions_unavailable"
        : known
          ? error.code
          : "processing_failed",
    error_message: message,
    ...(caption
      ? { status: "needs_captions" as const }
      : exhausted
        ? { status: "failed" as const }
        : {
            progress: { ...progress, retryAt: new Date(Date.now() + backoff).toISOString() },
          }),
  };
  if (caption) {
    patch.progress = { ...progress, stage: "needs-captions" };
  }
  const { data, error: writeError } = await supabase
    .from("video_ingestion_jobs")
    .update(patch)
    .eq("id", job.id)
    .select("*")
    .single();
  if (writeError || !data) {
    console.error("[video-ingestion] failure state could not be saved", {
      jobId: job.id,
      code: writeError?.code ?? "unknown",
    });
    return { ...job, status: "failed", error_message: message };
  }
  return data;
}

async function runStep(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lesson: LessonRow;
  job: JobRow;
  kind: VideoSourceKind;
}): Promise<{ patch: JobUpdate; continue: boolean }> {
  const progress = progressOf(input.job);
  const base = {
    attempt_count: 0,
    error_code: null,
    error_message: null,
  };

  if (input.job.status === "queued") {
    if (input.kind === "youtube" || input.kind === "vimeo") {
      const segments = await fetchLinkCaptions(input.kind, input.lesson.video_url);
      return {
        continue: false,
        patch: {
          ...base,
          status: "indexing",
          progress: asJson({
            ...progress,
            stage: "indexing",
            engine: "published-captions",
            segmentCount: segments.length,
            segments,
          } satisfies StoredProgress),
        },
      };
    }
    return {
      continue: true,
      patch: {
        ...base,
        status: "preparing",
        progress: { ...progress, stage: "reading-media", engine: "gemini-file" },
      },
    };
  }

  if (input.job.status === "preparing") {
    let reader: MediaReader;
    if (input.kind === "upload") {
      reader = await storageReader(input.supabase, input.lesson.video_url, input.userId);
    } else if (input.kind === "direct") {
      reader = await httpReader(input.lesson.video_url);
    } else {
      const segments = await fetchLinkCaptions(input.kind, input.lesson.video_url);
      return {
        continue: false,
        patch: {
          ...base,
          status: "indexing",
          progress: asJson({
            ...progress,
            stage: "indexing",
            engine: "published-captions",
            segmentCount: segments.length,
            segments,
          } satisfies StoredProgress),
        },
      };
    }

    const uploadUrl = progress.uploadUrl;
    if (!uploadUrl || progress.totalBytes !== reader.totalBytes) {
      const upload = await startMediaUpload({
        mimeType: reader.mimeType,
        size: reader.totalBytes,
        displayName: `${input.lesson.title.slice(0, 80) || "lesson"}.${reader.mimeType === "video/webm" ? "webm" : "mp4"}`,
      });
      return {
        continue: true,
        patch: {
          status: "preparing",
          attempt_count: 0,
          error_code: null,
          error_message: null,
          progress: {
            ...progress,
            stage: "uploading",
            engine: "gemini-file",
            uploadUrl: upload.uploadUrl,
            uploadedBytes: 0,
            totalBytes: reader.totalBytes,
            mimeType: reader.mimeType,
          },
        },
      };
    }

    const offset = Math.max(0, Math.min(progress.uploadedBytes ?? 0, reader.totalBytes));
    if (offset >= reader.totalBytes) {
      if (!progress.fileName) {
        throw new TranscriptionError(
          "upload_failed",
          "The media upload did not finish. Retry the processing job.",
          true,
        );
      }
      return {
        continue: true,
        patch: { status: "transcribing", progress: { ...progress, stage: "waiting-for-file" } },
      };
    }
    const length = Math.min(MEDIA_CHUNK_BYTES, reader.totalBytes - offset);
    const chunk = await reader.read(offset, length);
    const finalize = offset + chunk.byteLength >= reader.totalBytes;
    const uploaded = await uploadMediaChunk({
      uploadUrl,
      offset,
      bytes: chunk,
      mimeType: reader.mimeType,
      finalize,
    });
    return {
      continue: true,
      patch: {
        status: "preparing",
        progress: {
          ...progress,
          stage: "uploading",
          uploadedBytes: offset + chunk.byteLength,
          ...(uploaded.file ? { fileName: uploaded.file.name, fileUri: uploaded.file.uri } : {}),
        },
      },
    };
  }

  if (input.job.status === "transcribing") {
    if (!progress.fileUri) {
      throw new TranscriptionError(
        "upload_failed",
        "The uploaded media reference is missing. Retry processing.",
        true,
      );
    }
    const file = await getMediaFile(progress.fileName ?? progress.fileUri);
    if (file.state === "FAILED") {
      throw new TranscriptionError("unsupported_media", "The provider could not read this media.");
    }
    if (file.state !== "ACTIVE") {
      return { continue: false, patch: { status: "transcribing" } };
    }
    const transcript = await transcribeMediaFile({
      fileUri: file.uri,
      mimeType: progress.mimeType ?? "video/mp4",
      ...(input.lesson.duration_seconds > 0
        ? { mediaDurationSeconds: input.lesson.duration_seconds }
        : {}),
    });
    if (!transcript.segments.length) {
      throw new TranscriptionError(
        "transcript_empty",
        "No usable speech was found in this video's audio. Upload a captioned version or paste captions.",
      );
    }
    return {
      continue: true,
      patch: {
        status: "indexing",
        progress: asJson({
          ...progress,
          stage: "indexing",
          segmentCount: transcript.segments.length,
          providerModel: transcript.model,
          segments: transcript.segments,
        } satisfies StoredProgress),
      },
    };
  }

  if (input.job.status === "indexing") {
    const raw = (progress as StoredProgress).segments;
    const segments = Array.isArray(raw) ? raw : [];
    if (!segments.length) {
      throw new TranscriptionError(
        "transcription_failed",
        "The transcript was lost before indexing. Retry processing.",
        true,
      );
    }
    const lastEnd = segments.at(-1)?.end ?? 0;
    const duration =
      input.lesson.duration_seconds > 0
        ? input.lesson.duration_seconds
        : Math.max(1, Math.ceil(lastEnd));
    if (input.lesson.duration_seconds <= 0) {
      await input.supabase
        .from("lessons")
        .update({ duration_seconds: duration })
        .eq("id", input.lesson.id);
    }
    const cues = buildTranscriptCues(segments, lastEnd || duration);
    const vtt = buildTranscriptVtt(cues);
    const result = await ingestLessonResource({
      supabase: input.supabase,
      userId: input.userId,
      lessonId: input.lesson.id,
      filename: "auto-transcript.vtt",
      mimeType: "text/vtt",
      bytes: new TextEncoder().encode(vtt),
      provenance: {
        transcript_source: progress.engine ?? "gemini",
        model: progress.providerModel ?? transcriptionModel(),
        segment_count: segments.length,
        generated_at: new Date().toISOString(),
      },
    });
    if (result.status === "error") {
      if (result.code === "transcript_exists" || result.code === "duplicate_resource") {
        // A previous run may have saved the transcript before the vector index
        // finished (or before the additive RAG tables existed). Repair the
        // index idempotently instead of reporting a half-processed lesson as
        // fully ready for retrieval.
        const existing = await input.supabase
          .from("lessons")
          .select("id,title,user_id,course_id,is_demo,duration_seconds,transcript")
          .eq("id", input.lesson.id)
          .maybeSingle();
        const stored = existing.data ? transcriptSegments(existing.data.transcript) : [];
        if (existing.data && stored.length) {
          const indexed = await indexLessonVideo({
            supabase: input.supabase,
            lesson: existing.data,
            segments: stored,
          });
          if (indexed.status !== "ready") {
            console.warn("[ingestion] vector index repair not ready", {
              lessonId: input.lesson.id,
              reason: indexed.error ?? "unknown",
            });
          }
        }
        return {
          continue: false,
          patch: {
            ...base,
            status: "ready",
            progress: { ...progress, stage: "ready", cueCount: cues.length },
          },
        };
      }
      throw new TranscriptionError(
        "transcription_failed",
        result.message.slice(0, 300),
        result.code === "database_unavailable" || result.code === "storage_unavailable",
      );
    }
    return {
      continue: false,
      patch: {
        ...base,
        status: "ready",
        progress: {
          ...progress,
          stage: "ready",
          cueCount: cues.length,
          resourceId: result.resourceId,
        },
      },
    };
  }

  return { continue: false, patch: {} };
}
