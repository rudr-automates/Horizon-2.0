import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type {
  GeneratedQuiz,
  PracticeMode,
  QuizFailure,
  QuizGradeResponse,
  QuizQuestion,
  QuizQuestionResult,
  QuizResponse,
} from "@/lib/quiz-types";
import type { TutorCitation } from "@/lib/tutor-types";
import type { AiDatabase } from "../retrieval/ai-database";
import { EvidenceContractError, isEvidenceContractError } from "../retrieval/errors";
import { loadLessonEvidence } from "../retrieval/lesson-evidence.server";
import { buildGroundedContext, selectEligibleEvidence, validateScope } from "../retrieval/scope";
import type { EvidenceChunk } from "../retrieval/types";
import { isAiError } from "./errors";
import { getAiRuntime } from "./runtime.server";

type AiClient = SupabaseClient<AiDatabase>;

interface StoredQuestion {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  citations: TutorCitation[];
}

interface StoredAttempt {
  id: string;
  user_id: string;
  lesson_id: string;
  mode: PracticeMode;
  position_seconds: number;
  questions: unknown;
  answers: unknown;
  score: number | null;
  feedback: string | null;
  completed_at: string | null;
  created_at: string;
}

const MODE_COUNT: Record<PracticeMode, number> = { quiz: 4, exam: 6, interview: 4 };

// Six exam questions with four options and explanations do not fit in a
// 900-token budget: a truncated JSON body fails verification every time.
const MODE_OUTPUT_TOKENS: Record<PracticeMode, number> = {
  quiz: 1_600,
  exam: 2_600,
  interview: 1_600,
};

/** Video chunks order by their end time; documents (no position) sort first. */
function evidencePosition(chunk: EvidenceChunk): number {
  return chunk.locator.kind === "video" ? chunk.locator.endSeconds : -1;
}

function failure(code: QuizFailure["code"], message: string): QuizFailure {
  return { status: "error", code, message };
}

function citationFor(chunk: EvidenceChunk): TutorCitation {
  return {
    evidenceId: chunk.id,
    text: chunk.text.slice(0, 800),
    resourceKind: chunk.resourceKind,
    locator: chunk.locator,
    ...(chunk.provenance?.title === undefined ? {} : { title: chunk.provenance.title }),
    ...(chunk.provenance?.sourceUrl === undefined ? {} : { sourceUrl: chunk.provenance.sourceUrl }),
  };
}

function parseObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseQuestions(
  text: string,
  evidence: EvidenceChunk[],
  byToken: Map<string, EvidenceChunk>,
): { title: string; questions: StoredQuestion[] } | null {
  const payload = parseObject(text);
  if (!payload) return null;
  const title = typeof payload["title"] === "string" ? payload["title"].trim() : "Lesson check";
  const raw = Array.isArray(payload["questions"]) ? payload["questions"] : [];
  const questions: StoredQuestion[] = [];

  for (const item of raw.slice(0, 8)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const prompt = typeof row["prompt"] === "string" ? row["prompt"].trim() : "";
    const options = Array.isArray(row["options"])
      ? row["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => option.trim())
      : [];
    const answerIndex = row["answerIndex"];
    const explanation = typeof row["explanation"] === "string" ? row["explanation"].trim() : "";
    const rawIds = Array.isArray(row["evidenceIds"]) ? row["evidenceIds"] : [];
    if (
      !prompt ||
      options.length < 3 ||
      options.length > 4 ||
      new Set(options.map((option) => option.toLowerCase())).size !== options.length ||
      typeof answerIndex !== "number" ||
      !Number.isInteger(answerIndex) ||
      answerIndex < 0 ||
      answerIndex >= options.length
    ) {
      continue;
    }
    const citations: TutorCitation[] = [];
    for (const rawId of rawIds) {
      if (typeof rawId !== "string") continue;
      const chunk = byToken.get(rawId);
      if (chunk && !citations.some((citation) => citation.evidenceId === chunk.id)) {
        citations.push(citationFor(chunk));
      }
    }
    if (!citations.length) continue;
    questions.push({
      id: `q${questions.length + 1}`,
      prompt,
      options,
      answerIndex,
      explanation,
      citations,
    });
  }

  if (questions.length < 2) return null;
  // The evidence array is intentionally used to guarantee at least one eligible
  // source exists even when the model returns a shorter quiz than requested.
  if (!evidence.length) return null;
  return { title: title || "Lesson check", questions };
}

function publicQuestions(questions: StoredQuestion[]): QuizQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    options: question.options,
  }));
}

export async function generateQuiz(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  lessonId: string;
  positionSeconds: number;
  mode: PracticeMode;
}): Promise<QuizResponse> {
  try {
    const loaded = await loadLessonEvidence(input.supabase, input.lessonId);
    if (!loaded)
      return failure("lesson_not_found", "That lesson is unavailable or you do not have access.");
    const { lesson, chunks } = loaded;
    if (lesson.duration_seconds <= 0) {
      return failure("invalid_scope", "The lesson duration is not known yet.");
    }
    const scope = {
      userId: input.userId,
      ...(lesson.course_id === null ? {} : { courseId: lesson.course_id }),
      lessonId: lesson.id,
      lessonOwnerId: lesson.user_id,
      lessonIsDemo: lesson.is_demo,
      lessonDurationSeconds: lesson.duration_seconds,
      positionSeconds: input.positionSeconds,
    };
    validateScope(scope);
    const eligible = selectEligibleEvidence(scope, chunks);
    if (!eligible.length) {
      return failure(
        "retrieval_unavailable",
        "There is no eligible material yet. Play a little further first.",
      );
    }

    // Eligible rows arrive in database order: take the most recent material by
    // lesson position instead of whatever rows sort last.
    const selected = [...eligible]
      .sort((a, b) => evidencePosition(a) - evidencePosition(b))
      .slice(-10);
    const context = buildGroundedContext(scope, selected, {
      maxChunks: 8,
      maxTotalChars: 7_000,
      retrieval: "summary",
    });
    const byToken = new Map(context.evidence.map((item, index) => [`E${index + 1}`, item.id]));
    const byId = new Map(eligible.map((chunk) => [chunk.id, chunk]));
    const evidenceBlock = context.evidence
      .map(
        (item, index) =>
          `[E${index + 1}] (${item.resourceKind}; ${item.locator.kind})\n${item.text}`,
      )
      .join("\n\n");
    const count = MODE_COUNT[input.mode];
    const modeInstruction =
      input.mode === "interview"
        ? "Make these interview-style scenario questions that test whether the learner can apply the covered ideas."
        : input.mode === "exam"
          ? "Make these exam-style questions, slightly harder than a casual quiz."
          : "Make these friendly comprehension questions.";

    const completion = await getAiRuntime().gateway.generate({
      messages: [
        {
          role: "system",
          content: [
            "You write evidence-grounded multiple-choice checks for a learner.",
            "Use ONLY the supplied evidence. Do not test material after the learner's timestamp.",
            modeInstruction,
            `Write exactly ${count} questions with 4 options each. Exactly one option is correct. Avoid "all of the above" and trick wording.`,
            'Return JSON only: {"title":"...","questions":[{"prompt":"...","options":["..."],"answerIndex":0,"explanation":"...","evidenceIds":["E1"]}]}',
            "Every question needs at least one evidence id. The explanation must be supported by that evidence.",
          ].join("\n"),
        },
        {
          role: "user",
          content: `Lesson: ${lesson.title}\nCovered through: ${input.positionSeconds}s\n\nEligible evidence:\n\n${evidenceBlock}`,
        },
      ],
      maxOutputTokens: MODE_OUTPUT_TOKENS[input.mode],
      temperature: 0.3,
      responseFormat: "json",
      timeoutMs: 45_000,
    });

    const byTokenChunks = new Map(
      [...byToken.entries()]
        .map(([token, id]) => [token, byId.get(id)] as const)
        .filter((entry): entry is readonly [string, EvidenceChunk] => entry[1] !== undefined),
    );
    const parsed = parseQuestions(completion.text, eligible, byTokenChunks);
    if (!parsed) {
      // Model output may contain learner context; keep failure diagnostics content-free.
      console.warn(
        JSON.stringify({
          event: "ai.quiz_unparsed",
          mode: input.mode,
          correlationId: completion.correlationId,
          outputLength: completion.text.length,
        }),
      );
      return failure(
        "invalid_quiz",
        "The generated check could not be verified against the lesson evidence.",
      );
    }

    const db = input.supabase as unknown as AiClient;
    const inserted = await db
      .from("quiz_attempts")
      .insert({
        user_id: input.userId,
        lesson_id: lesson.id,
        mode: input.mode,
        position_seconds: input.positionSeconds,
        questions: parsed.questions,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      return failure(
        "storage_unavailable",
        "Practice storage is not available yet. Apply the retrieval migration and try again.",
      );
    }

    return {
      status: "ready",
      attemptId: inserted.data.id,
      title: parsed.title,
      mode: input.mode,
      questions: publicQuestions(parsed.questions),
    };
  } catch (error) {
    if (isEvidenceContractError(error)) {
      return failure(
        error.code === "unauthorized_scope" ? "invalid_scope" : "retrieval_unavailable",
        "This lesson's eligible evidence could not be prepared safely.",
      );
    }
    if (isAiError(error)) {
      return failure(
        error.code,
        "The free AI provider could not generate a check. No paid provider was tried.",
      );
    }
    return failure("unknown", "The practice check could not be generated.");
  }
}

export async function gradeQuiz(input: {
  supabase: SupabaseClient<Database>;
  userId: string;
  attemptId: string;
  answers: Array<number | null>;
}): Promise<QuizGradeResponse> {
  try {
    const db = input.supabase as unknown as AiClient;
    const { data, error } = await db
      .from("quiz_attempts")
      .select("*")
      .eq("id", input.attemptId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (error || !data) {
      return failure("storage_unavailable", "That practice attempt is unavailable.");
    }
    const attempt = data as StoredAttempt;
    const questions = Array.isArray(attempt.questions)
      ? (attempt.questions as StoredQuestion[])
      : [];
    if (!questions.length) return failure("invalid_quiz", "This attempt has no questions.");
    if (attempt.completed_at) {
      return failure("invalid_quiz", "This attempt has already been graded.");
    }

    let correct = 0;
    const results: QuizQuestionResult[] = questions.map((question, index) => {
      const selected = input.answers[index];
      const selectedIndex =
        typeof selected === "number" &&
        Number.isInteger(selected) &&
        selected >= 0 &&
        selected < question.options.length
          ? selected
          : null;
      const isCorrect = selectedIndex === question.answerIndex;
      if (isCorrect) correct += 1;
      return {
        id: question.id,
        prompt: question.prompt,
        options: question.options,
        selectedIndex,
        correctIndex: question.answerIndex,
        correct: isCorrect,
        explanation: question.explanation,
        citations: question.citations,
      };
    });
    const score = Math.round((correct / questions.length) * 100);
    const feedback =
      score === 100
        ? "All correct. You can explain this part of the lesson."
        : score >= 60
          ? "Good grasp. Review the explanations for the questions you missed."
          : "Review the cited passages before trying again.";

    const updated = await db
      .from("quiz_attempts")
      .update({
        answers: input.answers,
        score,
        feedback,
        completed_at: new Date().toISOString(),
      })
      .eq("id", attempt.id)
      .eq("user_id", input.userId);
    if (updated.error) return failure("storage_unavailable", "The result could not be saved.");

    return { status: "graded", attemptId: attempt.id, score, results };
  } catch {
    return failure("unknown", "The practice check could not be graded.");
  }
}
