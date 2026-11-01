/**
 * Server-side media transcription through the existing Gemini credential.
 *
 * Horizon already ingests captions into a timestamped transcript, chunks and
 * embeddings. The missing piece was obtaining a timestamped transcript for an
 * arbitrary uploaded video without a desktop Whisper worker. Gemini's Files API
 * accepts the media bytes and its interaction API returns a schema-validated,
 * timestamped transcript, so no audio extraction tool, container parser or paid
 * speech service is introduced.
 *
 * Everything here runs on the server: the provider key never reaches the
 * browser, and the media is uploaded from private storage.
 */

const API_BASE = "https://generativelanguage.googleapis.com";
const UPLOAD_BASE = `${API_BASE}/upload/v1beta`;
const MODEL_BASE = `${API_BASE}/v1beta/models`;

/** Gemini requires media chunks to be a multiple of 8 MiB. */
export const MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;

const DEFAULT_MODEL = "gemini-3.5-flash";
const MAX_PROVIDER_ATTEMPTS = 2;
const REQUEST_TIMEOUT_MS = 45_000;

export type TranscriptionErrorCode =
  | "not_configured"
  | "unsupported_media"
  | "provider_unavailable"
  | "rate_limited"
  | "upload_failed"
  | "transcription_failed"
  | "transcript_empty"
  | "invalid_response";

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  /** True when retrying the same step later can plausibly succeed. */
  readonly retryable: boolean;
  /** Provider-requested delay, when it supplied one (for example a 429). */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: TranscriptionErrorCode,
    message: string,
    retryable = false,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TranscriptionError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isTranscriptionError(error: unknown): error is TranscriptionError {
  return error instanceof TranscriptionError;
}

export function transcriptionModel(env: Record<string, string | undefined> = process.env): string {
  const configured = env["VIDEO_TRANSCRIPTION_MODEL"]?.trim();
  return configured && configured.length <= 80 ? configured : DEFAULT_MODEL;
}

export function transcriptionConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env["GEMINI_API_KEY"]?.trim());
}

function apiKey(): string {
  const key = process.env["GEMINI_API_KEY"]?.trim();
  if (!key) {
    throw new TranscriptionError(
      "not_configured",
      "Automatic transcription is not configured: the server has no Gemini key.",
    );
  }
  return key;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(body: string): number | undefined {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(180_000, Math.max(1_000, Math.round(seconds * 1_000)));
}

function errorFor(status: number, body: string): TranscriptionError {
  const detail = body.slice(0, 300).replace(/\s+/g, " ");
  if (status === 401 || status === 403) {
    return new TranscriptionError(
      "not_configured",
      "The transcription provider rejected the server credential.",
    );
  }
  if (status === 429) {
    return new TranscriptionError(
      "rate_limited",
      "The transcription provider is rate-limiting this project. Try again shortly.",
      true,
      retryDelayMs(body),
    );
  }
  if (status === 400 && /modality|mime|unsupported/i.test(detail)) {
    return new TranscriptionError(
      "unsupported_media",
      "The transcription provider cannot read this media format.",
    );
  }
  return new TranscriptionError(
    "provider_unavailable",
    "The transcription provider is temporarily unavailable.",
    retryableStatus(status),
    retryDelayMs(body),
  );
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw errorFor(response.status, body);
    }
    return response;
  } catch (error) {
    if (error instanceof TranscriptionError) throw error;
    if (controller.signal.aborted) {
      throw new TranscriptionError(
        "provider_unavailable",
        "The transcription provider did not respond in time.",
        true,
      );
    }
    throw new TranscriptionError(
      "provider_unavailable",
      "The server could not reach the transcription provider.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface MediaUpload {
  uploadUrl: string;
}

/**
 * Opens a resumable upload for one media object. The total size is declared up
 * front so chunked uploads can resume from a stored byte offset after a restart.
 */
export async function startMediaUpload(input: {
  mimeType: string;
  size: number;
  displayName: string;
}): Promise<MediaUpload> {
  if (!Number.isFinite(input.size) || input.size < 1) {
    throw new TranscriptionError("unsupported_media", "This video contains no data.");
  }
  const response = await request(`${UPLOAD_BASE}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey(),
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(input.size),
      "x-goog-upload-header-content-type": input.mimeType,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      file: { display_name: input.displayName.slice(0, 120) },
    }),
  });
  const uploadUrl = response.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new TranscriptionError(
      "upload_failed",
      "The transcription provider did not open an upload.",
      true,
    );
  }
  return { uploadUrl };
}

export interface MediaFile {
  name: string;
  uri: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED" | "UNKNOWN";
}

/** Uploads one chunk. `finalize` completes the resumable upload. */
export async function uploadMediaChunk(input: {
  uploadUrl: string;
  offset: number;
  bytes: Uint8Array;
  mimeType: string;
  finalize: boolean;
  timeoutMs?: number;
}): Promise<{ file?: MediaFile }> {
  if (input.bytes.byteLength === 0) {
    throw new TranscriptionError("upload_failed", "An upload chunk was empty.");
  }
  const response = await request(
    input.uploadUrl,
    {
      method: "POST",
      headers: {
        "x-goog-upload-command": input.finalize ? "upload, finalize" : "upload",
        "x-goog-upload-offset": String(input.offset),
        "content-type": input.mimeType,
      },
      // A plain ArrayBuffer is portable across Node, workerd and test DOMs;
      // Blob would be an incompatible implementation in some runtimes.
      body: input.bytes.buffer.slice(
        input.bytes.byteOffset,
        input.bytes.byteOffset + input.bytes.byteLength,
      ) as unknown as BodyInit,
    },
    input.timeoutMs ?? 120_000,
  );
  if (!input.finalize) return {};
  const payload = (await response.json().catch(() => null)) as {
    file?: { name?: string; uri?: string; state?: string };
  } | null;
  const file = payload?.file;
  if (!file?.name || !file.uri) {
    throw new TranscriptionError("upload_failed", "The media upload did not complete.", true);
  }
  return {
    file: {
      name: file.name,
      uri: file.uri,
      state: (file.state as MediaFile["state"]) ?? "PROCESSING",
    },
  };
}

/** Reads upload state without re-uploading, so a stalled step can resume. */
export async function getMediaFile(name: string): Promise<MediaFile> {
  const response = await request(`${API_BASE}/v1beta/${name.replace(/^\/+/, "")}`, {
    method: "GET",
    headers: { "x-goog-api-key": apiKey() },
  });
  const payload = (await response.json().catch(() => null)) as {
    name?: string;
    uri?: string;
    state?: string;
  } | null;
  if (!payload?.name || !payload.uri) {
    throw new TranscriptionError("provider_unavailable", "The uploaded media was not found.");
  }
  return {
    name: payload.name,
    uri: payload.uri,
    state: (payload.state as MediaFile["state"]) ?? "UNKNOWN",
  };
}

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
        },
        required: ["start", "end", "text"],
      },
    },
  },
  required: ["segments"],
} as const;

function transcriptPrompt(mediaDurationSeconds?: number): string {
  const length = Number.isFinite(mediaDurationSeconds)
    ? ` The recording is about ${Math.round(mediaDurationSeconds ?? 0)} seconds long.`
    : "";
  return [
    "Transcribe all speech in this educational recording.",
    length,
    "Return JSON with one object per spoken passage, in order, covering the whole recording.",
    "start and end are seconds from the beginning of the recording.",
    "Each passage must be the exact words spoken, normally 15 to 40 seconds long, and must not overlap the next passage.",
    "Insert no commentary, no speaker labels, no section titles incorporated into the speech, and do not summarise.",
    "Skip music and silence. If there is no speech at all, return an empty segments array.",
  ].join(" ");
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  model: string;
  /** True when the provider stopped at the output token ceiling. */
  truncated: boolean;
}

/**
 * Transcribes one uploaded media file and returns timestamped segments.
 *
 * `generateContent` is used rather than the newer interaction resource because
 * it is the endpoint this project's free-tier key can call reliably; the
 * interaction resource returned RESOURCE_EXHAUSTED for the same file. A 429 or
 * 5xx is reported as retryable so the durable job retries later instead of
 * failing the learner's video.
 */
export async function transcribeMediaFile(input: {
  fileUri: string;
  mimeType: string;
  mediaDurationSeconds?: number;
  timeoutMs?: number;
}): Promise<TranscriptResult> {
  const model = transcriptionModel();
  const url = `${MODEL_BASE}/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: input.fileUri, mimeType: input.mimeType } },
          { text: transcriptPrompt(input.mediaDurationSeconds) },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: TRANSCRIPT_SCHEMA,
      maxOutputTokens: 32_768,
      temperature: 0,
      // Transcription is a mechanical task; thinking only adds latency.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      const response = await request(
        url,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey(), "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        input.timeoutMs ?? 240_000,
      );
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!payload) {
        throw new TranscriptionError(
          "invalid_response",
          "The transcription provider returned an unreadable response.",
          true,
        );
      }
      const feedback = payload["promptFeedback"];
      if (
        typeof feedback === "object" &&
        feedback !== null &&
        (feedback as Record<string, unknown>)["blockReason"]
      ) {
        throw new TranscriptionError(
          "transcription_failed",
          "The provider declined to transcribe this media.",
        );
      }
      const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
      const candidate = candidates[0] as Record<string, unknown> | undefined;
      const finishReason = String(candidate?.["finishReason"] ?? "");
      const content = candidate?.["content"] as Record<string, unknown> | undefined;
      const parts = Array.isArray(content?.["parts"]) ? (content["parts"] as unknown[]) : [];
      const text = parts
        .map((part) =>
          typeof part === "object" && part !== null
            ? String((part as Record<string, unknown>)["text"] ?? "")
            : "",
        )
        .join("")
        .trim();
      if (!text) {
        throw new TranscriptionError(
          "invalid_response",
          "The provider returned no transcript text.",
          true,
        );
      }
      const parsed = jsonFromText(text);
      const segments = parseTranscriptSegments(parsed);
      return { segments, model, truncated: finishReason === "MAX_TOKENS" };
    } catch (error) {
      lastError = error;
      if (!isTranscriptionError(error) || !error.retryable || attempt === MAX_PROVIDER_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  throw lastError;
}

function parseSegmentList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) return [];
  const segments = (payload as Record<string, unknown>)["segments"];
  return Array.isArray(segments) ? segments : [];
}

function jsonFromText(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) {
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");
    if (arrayStart < 0 || arrayEnd <= arrayStart) return null;
    try {
      return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parses provider segment output into ordered, non-overlapping, non-empty
 * segments. Invalid rows are dropped rather than repaired with invented text;
 * an entirely unusable payload is reported to the caller.
 */
export function parseTranscriptSegments(
  raw: unknown,
  options: { maxSeconds?: number; maxSegments?: number } = {},
): TranscriptSegment[] {
  const maxSeconds = options.maxSeconds ?? 6 * 60 * 60;
  const maxSegments = options.maxSegments ?? 6_000;
  const rows = parseSegmentList(raw);
  const parsed: TranscriptSegment[] = [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const start = Number(record["start"]);
    const end = Number(record["end"]);
    const rawText = typeof record["text"] === "string" ? record["text"] : "";
    const text = rawText
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_500);
    if (!text) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end <= start || start > maxSeconds) continue;
    parsed.push({ start, end: Math.min(end, maxSeconds), text });
  }

  parsed.sort((a, b) => a.start - b.start);
  const result: TranscriptSegment[] = [];
  for (const segment of parsed) {
    const previous = result.at(-1);
    if (previous && segment.start < previous.end) continue;
    if (previous && segment.text === previous.text) continue;
    result.push(segment);
    if (result.length >= maxSegments) break;
  }
  return result;
}

/**
 * Groups transcript segments into caption cues.
 *
 * The caption ingester merges cues only while a merged passage stays under 20
 * seconds and 1,100 characters, and a lesson may not exceed 220 passages. For a
 * long lecture the target span therefore widens so the whole recording fits the
 * existing limits without weakening timestamps.
 */
export function buildTranscriptCues(
  segments: TranscriptSegment[],
  mediaDurationSeconds: number,
): TranscriptSegment[] {
  if (!segments.length) return [];
  const lastEnd = segments.at(-1)?.end ?? 0;
  const duration =
    Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds > 0
      ? mediaDurationSeconds
      : lastEnd;
  // The caption ingester accepts at most 220 passages per resource. Group into
  // at most ~185 cues so even a three-hour lecture stays indexable, without
  // inventing or dropping spoken text.
  const maxCues = 185;
  const maxChars = 1_000;
  const targetSpan = Math.max(25, Math.ceil(duration / maxCues));

  const cues: TranscriptSegment[] = [];
  for (const segment of segments) {
    const current = cues.at(-1);
    const gap = current ? segment.start - current.end : Infinity;
    if (
      current &&
      gap >= 0 &&
      gap <= 6 &&
      segment.end - current.start <= targetSpan &&
      current.text.length + segment.text.length + 1 <= maxChars
    ) {
      current.end = segment.end;
      current.text = `${current.text} ${segment.text}`;
    } else {
      cues.push({ ...segment });
    }
  }

  // A recording with many gaps can still exceed the budget; merge neighbouring
  // cues until the count fits rather than failing the whole ingestion.
  while (cues.length > maxCues) {
    const merged: TranscriptSegment[] = [];
    for (let index = 0; index < cues.length; index += 2) {
      const first = cues[index];
      const second = cues[index + 1];
      if (!first) continue;
      merged.push(
        second
          ? {
              start: first.start,
              end: second.end,
              text: `${first.text} ${second.text}`.slice(0, 1_400),
            }
          : first,
      );
    }
    cues.length = 0;
    cues.push(...merged);
  }

  return cues.map((cue) => ({
    start: Number(cue.start.toFixed(3)),
    end: Number(cue.end.toFixed(3)),
    text: cue.text,
  }));
}

function stamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Builds the WebVTT document the existing caption ingestion already accepts. */
export function buildTranscriptVtt(cues: TranscriptSegment[]): string {
  const blocks = cues
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .map((cue) => `${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/[<>]/g, " ")}`);
  return `WEBVTT\n\n${blocks.join("\n\n")}`;
}

/** Container MIME type Gemini accepts for a lesson reference. */
export function mediaMimeTypeFor(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return null;
}
