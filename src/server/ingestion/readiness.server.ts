import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type ReadinessState = "ready" | "processing" | "needs_captions" | "failed" | "unprocessed";

export interface LessonReadiness {
  state: ReadinessState;
  message: string;
  stage?: string;
  canRetry: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "queued",
  "reading-media": "preparing the media",
  uploading: "uploading the media",
  "reading-captions": "reading published captions",
  "waiting-for-file": "preparing the transcript",
  transcribing: "transcribing the audio",
  indexing: "indexing the transcript",
};

/**
 * Explains why a lesson has no usable transcript yet.
 *
 * The tutor, the simplifier, the summariser and the quiz generator all call this
 * before retrieval so a video that is still being processed never produces the
 * misleading "nothing you have reached is available" message.
 */
export async function lessonTranscriptReadiness(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lesson: {
    id: string;
    is_demo: boolean;
    video_url: string;
    transcript_status: string;
    transcript: unknown;
  };
}): Promise<LessonReadiness> {
  if (Array.isArray(input.lesson.transcript) && input.lesson.transcript.length > 0) {
    return { state: "ready", message: "The transcript is ready.", canRetry: false };
  }
  if (input.lesson.is_demo) {
    return { state: "ready", message: "This demonstration lesson is indexed.", canRetry: false };
  }

  const { data, error } = await input.supabase
    .from("video_ingestion_jobs")
    .select("status,progress,error_message,error_code,source_url")
    .eq("lesson_id", input.lesson.id)
    .eq("user_id", input.userId)
    .eq("source_url", input.lesson.video_url)
    .maybeSingle();
  if (error && error.code !== "42P01") {
    return {
      state: "unprocessed",
      message:
        "This video's transcript has not been prepared yet. Open the Transcript tab to start automatic processing.",
      canRetry: true,
    };
  }
  if (!data) {
    return {
      state: "unprocessed",
      message:
        "This video's transcript has not been prepared yet. Open the Transcript tab to start automatic processing, or upload the video file.",
      canRetry: true,
    };
  }

  const progress = (data.progress ?? {}) as { stage?: string };
  const stage = progress.stage ?? "";
  if (data.status === "ready") {
    return { state: "ready", message: "The transcript is ready.", canRetry: false };
  }
  if (data.status === "needs_captions") {
    return {
      state: "needs_captions",
      message:
        data.error_message ??
        "This video has no captions Horizon can read. Upload the video file or paste timestamped captions.",
      canRetry: true,
    };
  }
  if (data.status === "failed") {
    return {
      state: "failed",
      message:
        data.error_message ??
        "Automatic transcript processing failed. Retry from the Transcript tab or paste captions.",
      canRetry: true,
    };
  }
  return {
    state: "processing",
    stage: STAGE_LABELS[stage] ?? "preparing the transcript",
    message: `Horizon is still preparing this video's transcript (${
      STAGE_LABELS[stage] ?? "preparing"
    }). Questions, explanations, summaries and quizzes start working as soon as indexing finishes.`,
    canRetry: true,
  };
}
