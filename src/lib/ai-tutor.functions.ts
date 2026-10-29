import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AiDatabase } from "@/server/retrieval/ai-database";

const tutorRequestSchema = z.object({
  lessonId: z.string().trim().min(1).max(200),
  positionSeconds: z.number().finite().min(0).max(21_600),
  question: z.string().trim().min(2).max(1_000),
  mode: z.enum(["question", "explain", "summary"]).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2_000),
      }),
    )
    .max(4)
    .optional(),
});

export const askLessonTutor = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => tutorRequestSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { answerLessonQuestion } = await import("@/server/ai/lesson-tutor.server");
    return answerLessonQuestion({
      lessonId: data.lessonId,
      positionSeconds: data.positionSeconds,
      question: data.question,
      ...(data.mode === undefined ? {} : { mode: data.mode }),
      ...(data.history === undefined ? {} : { history: data.history }),
      supabase: context.supabase,
      userId: context.userId,
    });
  });

export const getTutorStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { getAiProviderStatus } = await import("@/server/ai/runtime.server");
    return getAiProviderStatus();
  });

const feedbackSchema = z.object({
  exchangeId: z.string().uuid(),
  helpful: z.boolean(),
});

const quizSchema = z.object({
  lessonId: z.string().trim().min(1).max(200),
  positionSeconds: z.number().finite().min(0).max(21_600),
  mode: z.enum(["quiz", "exam", "interview"]),
});

const gradeSchema = z.object({
  attemptId: z.string().uuid(),
  answers: z.array(z.number().int().min(0).max(10).nullable()).max(8),
});

export const setTutorFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => feedbackSchema.parse(input))
  .handler(async ({ data, context }) => {
    const db = context.supabase as unknown as SupabaseClient<AiDatabase>;
    const { error } = await db
      .from("tutor_exchanges")
      .update({ helpful: data.helpful })
      .eq("id", data.exchangeId)
      .eq("user_id", context.userId);
    if (error) return { ok: false as const, message: "Feedback could not be saved." };
    return { ok: true as const };
  });

export const generateLessonQuiz = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => quizSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { generateQuiz } = await import("@/server/ai/quiz.server");
    return generateQuiz({
      supabase: context.supabase,
      userId: context.userId,
      lessonId: data.lessonId,
      positionSeconds: data.positionSeconds,
      mode: data.mode,
    });
  });

export const gradeLessonQuiz = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => gradeSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { gradeQuiz } = await import("@/server/ai/quiz.server");
    return gradeQuiz({
      supabase: context.supabase,
      userId: context.userId,
      attemptId: data.attemptId,
      answers: data.answers,
    });
  });
