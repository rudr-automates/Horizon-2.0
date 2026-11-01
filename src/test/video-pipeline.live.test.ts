import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { answerLessonQuestion } from "@/server/ai/lesson-tutor.server";
import { generateQuiz } from "@/server/ai/quiz.server";
import {
  advanceIngestion,
  getIngestionStatus,
  videoSourceKind,
} from "@/server/ingestion/video-pipeline.server";

/**
 * Real end-to-end check for a newly uploaded video. It needs provider keys, a
 * confirmed learner and a short spoken MP4; nothing runs without opt-in.
 *
 * Set E2E_LESSON_ID to re-run only the learning-feature assertions against a
 * lesson created by a previous run. E2E_KEEP_LESSON=1 keeps the created lesson
 * (and prints its id) instead of cleaning it up.
 */
const configured = Boolean(
  process.env["RUN_LIVE_VIDEO_PIPELINE"] === "1" &&
  process.env["SUPABASE_URL"] &&
  process.env["SUPABASE_PUBLISHABLE_KEY"] &&
  process.env["E2E_TEST_EMAIL"] &&
  process.env["E2E_TEST_PASSWORD"] &&
  process.env["GEMINI_API_KEY"],
);

async function learnerClient(): Promise<{ client: SupabaseClient<Database>; userId: string }> {
  const client = createClient<Database>(
    process.env["SUPABASE_URL"]!,
    process.env["SUPABASE_PUBLISHABLE_KEY"]!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: process.env["E2E_TEST_EMAIL"]!,
    password: process.env["E2E_TEST_PASSWORD"]!,
  });
  expect(error).toBeNull();
  expect(data.user?.id).toBeTruthy();
  return { client, userId: data.user!.id };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!configured)("uploaded video ingestion pipeline", () => {
  it("processes a new upload and grounds all four learning features", async () => {
    const { client, userId } = await learnerClient();
    const reusedLessonId = process.env["E2E_LESSON_ID"]?.trim() || "";
    const only = process.env["E2E_ONLY"]?.trim() || "";
    const keepLesson = process.env["E2E_KEEP_LESSON"] === "1" || Boolean(reusedLessonId);
    const lessonId = reusedLessonId || randomUUID();
    const storagePath = `${userId}/${randomUUID()}.mp4`;
    let createdHere = false;

    try {
      if (reusedLessonId) {
        const existing = await client
          .from("lessons")
          .select("id,video_url,duration_seconds,transcript_status")
          .eq("id", lessonId)
          .maybeSingle();
        expect(existing.error).toBeNull();
        expect(existing.data?.transcript_status).toBe("available");
      } else {
        const bytes = new Uint8Array(await readFile(process.env["E2E_VIDEO_PATH"]!));
        const upload = await client.storage
          .from("lesson-videos")
          .upload(storagePath, bytes, { contentType: "video/mp4" });
        expect(upload.error).toBeNull();

        const inserted = await client
          .from("lessons")
          .insert({
            id: lessonId,
            user_id: userId,
            title: "Pipeline verification lesson",
            description: "Temporary lesson created by the live ingestion test.",
            video_url: `storage://lesson-videos/${storagePath}`,
            provider: "direct",
            transcript_status: "unavailable",
            duration_seconds: 0,
          })
          .select("id")
          .single();
        expect(inserted.error).toBeNull();
        createdHere = true;

        expect(videoSourceKind(`storage://lesson-videos/${storagePath}`)).toBe("upload");

        // Before processing there is no transcript. The tutor must say so
        // instead of claiming the learner has not watched enough.
        const early = await getIngestionStatus({ supabase: client, userId, lessonId });
        expect(early.state).toBe("none");
        const beforeProcessing = await answerLessonQuestion({
          supabase: client,
          userId,
          lessonId,
          positionSeconds: 1,
          question: "What is RoPE?",
        });
        expect(beforeProcessing.status).toBe("processing");

        let status = early;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          status = await advanceIngestion({ supabase: client, userId, lessonId });
          if (["ready", "failed", "needs_captions"].includes(status.state)) break;
          await pause(2_000);
        }
        if (status.state !== "ready") {
          const job = await client
            .from("video_ingestion_jobs")
            .select("status,error_code,error_message,attempt_count,progress")
            .eq("lesson_id", lessonId)
            .maybeSingle();
          console.log("job", JSON.stringify(job.data));
          throw new Error(`Ingestion ended in ${status.state}: ${status.message}`);
        }
      }

      const lesson = await client
        .from("lessons")
        .select("transcript_status,transcript,duration_seconds")
        .eq("id", lessonId)
        .single();
      expect(lesson.error).toBeNull();
      expect(lesson.data?.transcript_status).toBe("available");
      const transcript = Array.isArray(lesson.data?.transcript) ? lesson.data.transcript : [];
      expect(transcript.length).toBeGreaterThan(3);
      const duration = lesson.data?.duration_seconds ?? 0;
      expect(duration).toBeGreaterThan(30);

      const resources = await client
        .from("learning_resources")
        .select("id,kind,status,metadata")
        .eq("lesson_id", lessonId)
        .eq("kind", "video_transcript");
      expect(resources.error).toBeNull();
      expect(resources.data?.length).toBe(1);
      expect(resources.data?.[0]?.status).toBe("ready");
      const resourceId = resources.data![0]!.id;

      const chunks = await client
        .from("resource_chunks")
        .select("id,locator_kind,video_start_seconds,video_end_seconds,embedding")
        .eq("resource_id", resourceId)
        .order("chunk_index");
      expect(chunks.error).toBeNull();
      expect(chunks.data?.length).toBeGreaterThan(0);
      expect(chunks.data?.every((chunk) => chunk.locator_kind === "video")).toBe(true);
      expect(chunks.data?.every((chunk) => Number(chunk.video_end_seconds) <= duration + 1)).toBe(
        true,
      );
      expect(chunks.data?.every((chunk) => chunk.embedding !== null)).toBe(true);

      const ask = async (position: number, question: string, mode?: "explain" | "summary") => {
        const response = await answerLessonQuestion({
          supabase: client,
          userId,
          lessonId,
          positionSeconds: position,
          question,
          ...(mode === undefined ? {} : { mode }),
        });
        console.log(
          `[tutor ${mode ?? "question"} @${position}s] ${response.status} ${JSON.stringify(
            response.status === "answered"
              ? {
                  citations: response.citations.length,
                  provider: response.providerId,
                  retrieval: response.retrieval,
                }
              : response,
          ).slice(0, 400)}`,
        );
        return response;
      };
      if (!only || only === "question") {
        const answer = await ask(duration, "What does RoPE encode, and how?");
        expect(answer.status).toBe("answered");
        if (answer.status !== "answered") return;
        expect(answer.answer.length).toBeGreaterThan(10);
        expect(answer.citations.length).toBeGreaterThan(0);
        expect(answer.answer.toLowerCase()).toMatch(/rotat|position|rope/);
        for (const citation of answer.citations) {
          if (citation.locator.kind !== "video") continue;
          expect(citation.locator.lessonId).toBe(lessonId);
          expect(citation.locator.endSeconds).toBeLessThanOrEqual(duration + 0.001);
        }
        await pause(20_000);
      }

      if (!only || only === "explain") {
        const explain = await ask(
          duration,
          "Explain the covered material around this point simply.",
          "explain",
        );
        expect(explain.status).toBe("answered");
        await pause(20_000);
      }

      if (!only || only === "summary") {
        const summary = await ask(duration, "Summarize the key ideas covered so far.", "summary");
        expect(summary.status).toBe("answered");
        if (summary.status === "answered") expect(summary.answer.length).toBeGreaterThan(20);
        await pause(20_000);
      }

      await pause(only ? 2_000 : 20_000);
      // Position gating: only the opening passage is eligible at 5 s, so the
      // later RoPE material cannot be cited yet.
      const earlyAnswer = await ask(5, "What does RoPE encode?");
      if (earlyAnswer.status === "answered") {
        for (const citation of earlyAnswer.citations) {
          if (citation.locator.kind === "video") {
            expect(citation.locator.endSeconds).toBeLessThanOrEqual(5.001);
          }
        }
      } else {
        expect(earlyAnswer.status).toBe("insufficient_evidence");
      }
      await pause(only ? 2_000 : 20_000);
      const quiz = await generateQuiz({
        supabase: client,
        userId,
        lessonId,
        positionSeconds: duration,
        mode: "quiz",
      });
      console.log(`[quiz] ${quiz.status} ${quiz.status === "error" ? quiz.message : ""}`);
      expect(quiz.status).toBe("ready");
      if (quiz.status === "ready") expect(quiz.questions.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (createdHere && !keepLesson) {
        await client.from("lessons").delete().eq("id", lessonId);
        await client.storage.from("lesson-videos").remove([storagePath]);
      } else {
        console.log(`lesson kept: ${lessonId}`);
      }
    }
  }, 900_000);
});
