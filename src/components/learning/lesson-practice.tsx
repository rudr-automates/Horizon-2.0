import { useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Loader2,
  PlayCircle,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { GeneratedQuiz, PracticeMode, QuizGradeResponse, QuizResult } from "@/lib/quiz-types";
import type { TutorCitation } from "@/lib/tutor-types";
import { formatPosition } from "@/lib/learning";
import { supabase } from "@/integrations/supabase/client";
import { generateLessonQuiz, gradeLessonQuiz } from "@/lib/ai-tutor.functions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MODES: Array<{ id: PracticeMode; label: string }> = [
  { id: "quiz", label: "Quick quiz" },
  { id: "exam", label: "Exam drill" },
  { id: "interview", label: "Interview drill" },
];

function authHeaders(session: { access_token: string } | null | undefined) {
  return session ? { authorization: `Bearer ${session.access_token}` } : undefined;
}

function citationLabel(citation: TutorCitation): string {
  const locator = citation.locator;
  if (locator.kind === "video") return formatPosition(locator.startSeconds);
  if (locator.kind === "page") return `p. ${locator.pageNumber}`;
  if (locator.kind === "slide") return `slide ${locator.slideNumber}`;
  return locator.section ?? "notes";
}

export function LessonPractice({
  lessonId,
  position,
  onSeek,
}: {
  lessonId: string;
  position: number;
  onSeek: (time: number) => void;
}) {
  const [mode, setMode] = useState<PracticeMode>("quiz");
  const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate(nextMode: PracticeMode) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setQuiz(null);
    setResult(null);
    setAnswers({});
    setMode(nextMode);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setError("Your session expired. Sign in again to practise.");
        return;
      }
      const headers = authHeaders(data.session);
      const response = await generateLessonQuiz(
        headers
          ? { data: { lessonId, positionSeconds: Math.max(0, position), mode: nextMode }, headers }
          : { data: { lessonId, positionSeconds: Math.max(0, position), mode: nextMode } },
      );
      if (response.status === "ready") setQuiz(response);
      else setError(response.message);
    } catch {
      setError("The practice check could not be generated. No questions were invented.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!quiz || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setError("Your session expired. Sign in again to submit.");
        return;
      }
      const ordered = quiz.questions.map((question) => answers[question.id] ?? null);
      if (ordered.some((answer) => answer === null)) {
        setError("Answer every question before submitting.");
        return;
      }
      const headers = authHeaders(data.session);
      const response: QuizGradeResponse = await gradeLessonQuiz(
        headers
          ? { data: { attemptId: quiz.attemptId, answers: ordered }, headers }
          : { data: { attemptId: quiz.attemptId, answers: ordered } },
      );
      if (response.status === "graded") setResult(response);
      else setError(response.message);
    } catch {
      setError("The attempt could not be graded or saved.");
    } finally {
      setBusy(false);
    }
  }

  function openCitation(citation: TutorCitation) {
    if (citation.locator.kind === "video") {
      onSeek(citation.locator.startSeconds);
      return;
    }
    if (citation.sourceUrl && typeof window !== "undefined") {
      const hash = citation.locator.kind === "page" ? `#page=${citation.locator.pageNumber}` : "";
      window.open(`${citation.sourceUrl}${hash}`, "_blank", "noopener,noreferrer");
    }
  }

  const answeredCount = quiz
    ? quiz.questions.filter((question) => answers[question.id] !== undefined).length
    : 0;

  return (
    <section className="rounded-lg border bg-paper p-4" aria-labelledby="practice-heading">
      <h2 id="practice-heading" className="text-2xl">
        Practice what you have reached
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Generated from eligible lesson evidence only. Attempts are saved to your account.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {MODES.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={mode === option.id && quiz ? "secondary" : "outline"}
            disabled={busy}
            onClick={() => void generate(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>

      {busy && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Building a verified check from your covered material…
        </p>
      )}

      {error && (
        <p
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          {error}
        </p>
      )}

      {quiz && !result && (
        <form
          className="mt-4 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg">{quiz.title}</h3>
            <span className="text-xs text-muted-foreground">
              {answeredCount}/{quiz.questions.length} answered
            </span>
          </div>
          {quiz.questions.map((question, index) => (
            <fieldset key={question.id} className="border-t pt-4">
              <legend className="text-sm font-semibold leading-6">
                {index + 1}. {question.prompt}
              </legend>
              <div className="mt-2 grid gap-2">
                {question.options.map((option, optionIndex) => {
                  const selected = answers[question.id] === optionIndex;
                  return (
                    <button
                      key={`${question.id}-${optionIndex}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() =>
                        setAnswers((current) => ({ ...current, [question.id]: optionIndex }))
                      }
                      className={cn(
                        "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        selected
                          ? "border-primary bg-accent text-accent-foreground"
                          : "hover:border-primary/60 hover:bg-muted/40",
                      )}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            Submit and save attempt
          </Button>
        </form>
      )}

      {result && quiz && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 p-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Saved result</p>
              <p className="text-2xl">{result.score}%</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void generate(mode)}>
              <RotateCcw />
              Try another {mode === "quiz" ? "quiz" : "round"}
            </Button>
          </div>
          <ol className="space-y-4">
            {result.results.map((question, index) => (
              <li key={question.id} className="border-t pt-4">
                <p className="flex items-start gap-2 text-sm font-semibold">
                  {question.correct ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-forest" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  {index + 1}. {question.prompt}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Correct answer: {question.options[question.correctIndex]}
                  {question.selectedIndex === null
                    ? " · unanswered"
                    : question.correct
                      ? " · you chose correctly"
                      : ` · you chose: ${question.options[question.selectedIndex]}`}
                </p>
                <p className="mt-2 text-sm">{question.explanation}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {question.citations.map((citation) => (
                    <button
                      key={`${question.id}-${citation.evidenceId}`}
                      type="button"
                      onClick={() => openCitation(citation)}
                      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] hover:border-primary hover:text-primary"
                    >
                      {citation.locator.kind === "video" ? (
                        <PlayCircle className="size-3" />
                      ) : (
                        <BookOpen className="size-3" />
                      )}
                      {citation.title ? `${citation.title} · ` : ""}
                      {citationLabel(citation)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {!quiz && !busy && !error && (
        <p className="mt-4 text-sm text-muted-foreground">
          Pick a format above. Generated checks stop at the current playback position.
        </p>
      )}
    </section>
  );
}
