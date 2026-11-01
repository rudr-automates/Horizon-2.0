import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ingestLessonResource } from "@/server/ingestion/service.server";
import { answerLessonQuestion } from "@/server/ai/lesson-tutor.server";
import { generateQuiz } from "@/server/ai/quiz.server";
import type { RagDatabase } from "@/server/rag/database";

/**
 * Exercises the exact hook a new upload uses: a new private lesson, its
 * timestamped transcript is ingested, the central indexer runs, and all four
 * features answer from the pgvector evidence. The fixture is a caption track
 * (a supported upload path); automatic video transcription is covered by the
 * existing upload pipeline test.
 *
 * RUN_LIVE_RAG_FEATURES=1 npx vitest run src/test/rag-features.live.test.ts
 */
const configured = Boolean(
  process.env["RUN_LIVE_RAG_FEATURES"] === "1" &&
  process.env["SUPABASE_URL"] &&
  process.env["SUPABASE_PUBLISHABLE_KEY"] &&
  process.env["E2E_TEST_EMAIL"] &&
  process.env["E2E_TEST_PASSWORD"] &&
  process.env["GEMINI_API_KEY"],
);

async function learner(): Promise<{ client: SupabaseClient<Database>; userId: string }> {
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
  return { client, userId: data.user!.id };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const CUES = [
  "Spaced repetition improves long term memory by spreading review sessions over time.",
  "A common starting schedule is one day, then three days, one week, two weeks, and one month.",
  "Retrieval practice means trying to recall the answer before checking the source.",
  "Checking first creates familiarity, but recall first actually tests memory.",
  "An item answered incorrectly returns to the beginning of the review schedule.",
  "Interleaving mixes related topics instead of practicing one block at a time.",
  "Mixing topics forces you to choose which method fits each problem and improves transfer.",
  "Keep one idea on each review card so a wrong answer identifies the exact fact to review.",
  "Short daily sessions are easier to sustain than a single long session each week.",
  "Review the missed cards sooner, then let the successful cards wait longer.",
];

function buildVtt(): string {
  const lines = ["WEBVTT", ""];
  CUES.forEach((text, index) => {
    const start = index * 12;
    const end = start + 12;
    const stamp = (seconds: number) =>
      `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000`;
    lines.push(`${index + 1}`, `${stamp(start)} --> ${stamp(end)}`, text, "");
  });
  return lines.join("\n");
}

describe.skipIf(!configured)("pgvector learning features", () => {
  it("indexes a new lesson and grounds all four features", async () => {
    const { client, userId } = await learner();
    const lessonId = randomUUID();
    let storagePath: string | undefined;

    try {
      const inserted = await client.from("lessons").insert({
        id: lessonId,
        user_id: userId,
        title: "Spaced repetition fundamentals",
        description: "Temporary lesson created by the live RAG feature test.",
        video_url: "https://example.com/spaced-repetition.mp4",
        provider: "direct",
        transcript_status: "unavailable",
        duration_seconds: 120,
      });
      expect(inserted.error).toBeNull();

      const result = await ingestLessonResource({
        supabase: client,
        userId,
        lessonId,
        filename: "spaced-repetition.vtt",
        mimeType: "text/vtt",
        bytes: new TextEncoder().encode(buildVtt()),
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;

      const resources = await client
        .from("learning_resources")
        .select("metadata")
        .eq("lesson_id", lessonId)
        .single();
      storagePath =
        typeof resources.data?.metadata === "object" && resources.data.metadata !== null
          ? ((resources.data.metadata as Record<string, unknown>)["storage_path"] as string)
          : undefined;

      const rag = client as unknown as SupabaseClient<RagDatabase>;
      const index = await rag
        .from("video_indexes")
        .select("status,chunk_count,embedding_dimension,embedding_model")
        .eq("lesson_id", lessonId)
        .single();
      expect(index.error).toBeNull();
      expect(index.data?.status).toBe("ready");
      expect(index.data?.chunk_count).toBeGreaterThan(0);
      expect(index.data?.embedding_dimension).toBe(768);
      expect(index.data?.embedding_model).toBe("gemini-embedding-001");

      const chunks = await rag
        .from("video_chunks")
        .select("text,start_seconds,end_seconds,embedding_dimension")
        .eq("lesson_id", lessonId)
        .order("chunk_index");
      expect(chunks.error).toBeNull();
      expect(chunks.data?.length).toBe(index.data?.chunk_count);
      expect(chunks.data?.every((chunk) => chunk.embedding_dimension === 768)).toBe(true);

      const only = process.env["E2E_ONLY"]?.trim() || "";
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
          `[rag feature ${mode ?? "question"} @${position}s] ${response.status} ${JSON.stringify(
            response.status === "answered"
              ? { retrieval: response.retrieval, citations: response.citations.length }
              : response,
          ).slice(0, 400)}`,
        );
        return response;
      };

      if (!only || only === "answer") {
        const answer = await ask(
          120,
          "What is a common starting review schedule, and why should retrieval come before checking?",
        );
        expect(answer.status).toBe("answered");
        if (answer.status === "answered") {
          expect(answer.citations.length).toBeGreaterThan(0);
          for (const citation of answer.citations) {
            if (citation.locator.kind === "video") {
              expect(citation.locator.lessonId).toBe(lessonId);
              expect(citation.locator.endSeconds).toBeLessThanOrEqual(120);
            }
          }
        }
      }

      if (!only) await pause(20_000);
      if (!only || only === "explain") {
        const explain = await ask(120, "Explain how interleaving helps simply.", "explain");
        expect(explain.status).toBe("answered");
      }

      if (!only) await pause(20_000);
      if (!only || only === "summary") {
        const summary = await ask(120, "Summarize the key ideas covered so far.", "summary");
        expect(summary.status).toBe("answered");
        if (summary.status === "answered") {
          expect(summary.retrieval).toBe("summary");
          for (const citation of summary.citations) {
            if (citation.locator.kind === "video") {
              expect(citation.locator.endSeconds).toBeLessThanOrEqual(120);
            }
          }
        }
      }

      if (!only || only === "gate") {
        // Interleaving is discussed at 60s. At 10s only the opening passage is
        // covered, so the answer must not cite later material.
        const early = await ask(10, "How does interleaving help transfer?");
        if (early.status === "answered") {
          for (const citation of early.citations) {
            if (citation.locator.kind === "video") {
              expect(citation.locator.endSeconds).toBeLessThanOrEqual(10);
            }
          }
        } else {
          expect(early.status).toBe("insufficient_evidence");
        }
      }

      if (!only) await pause(20_000);
      const quiz = await generateQuiz({
        supabase: client,
        userId,
        lessonId,
        positionSeconds: 120,
        mode: "quiz",
      });
      console.log(`[rag feature quiz] ${quiz.status} ${JSON.stringify(quiz).slice(0, 700)}`);
      expect(quiz.status).toBe("ready");
      if (quiz.status === "ready") {
        expect(quiz.questions.length).toBeGreaterThanOrEqual(2);
        for (const question of quiz.questions) {
          expect(question.options.length).toBe(4);
        }
      }
    } finally {
      await client.from("lessons").delete().eq("id", lessonId);
      if (storagePath) await client.storage.from("learning-resources").remove([storagePath]);
    }
  }, 600_000);
});
