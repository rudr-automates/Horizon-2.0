import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  ExternalLink,
  Loader2,
  PlayCircle,
  Quote,
  Send,
  Sparkles,
} from "lucide-react";
import { formatPosition } from "@/lib/learning";
import type { TutorCitation, TutorMode, TutorRequest, TutorResponse } from "@/lib/tutor-types";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { askLessonTutor, getTutorStatus, setTutorFeedback } from "@/lib/ai-tutor.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ProviderStatus = Awaited<ReturnType<typeof getTutorStatus>>;

interface Turn {
  question: string;
  response: TutorResponse;
}

function authHeaders(session: { access_token: string } | null | undefined) {
  return session ? { authorization: `Bearer ${session.access_token}` } : undefined;
}

function exchangeIdOf(response: TutorResponse): string | undefined {
  return response.status === "answered" ? response.exchangeId : undefined;
}

function locatorText(citation: TutorCitation): string {
  const locator = citation.locator;
  if (locator.kind === "video") {
    return `${formatPosition(locator.startSeconds)}–${formatPosition(locator.endSeconds)}`;
  }
  if (locator.kind === "page") return `Page ${locator.pageNumber}`;
  if (locator.kind === "slide") return `Slide ${locator.slideNumber}`;
  return locator.section ?? "Notes";
}

function isOpenable(citation: TutorCitation): boolean {
  return citation.locator.kind === "video" || Boolean(citation.sourceUrl);
}

function citationHref(citation: TutorCitation): string | undefined {
  if (!citation.sourceUrl) return undefined;
  if (citation.locator.kind === "page")
    return `${citation.sourceUrl}#page=${citation.locator.pageNumber}`;
  return citation.sourceUrl;
}

function errorCopy(response: Extract<TutorResponse, { status: "error" }>): string {
  if (response.code === "missing_credentials") {
    return "The AI provider is not configured on this server. Add the server-side provider key and restart the app.";
  }
  if (response.code === "authentication_failed") {
    return "The server's AI provider credentials were rejected. The key was not sent to the browser.";
  }
  if (response.code === "rate_limited" || response.code === "quota_exhausted") {
    return `The free AI quota is limited. ${response.retryAfterSeconds ? `Try again in ${response.retryAfterSeconds}s.` : "Try again later."} No paid provider was used.`;
  }
  if (response.code === "citation_invalid") {
    return "The answer could not be tied to eligible lesson evidence, so it was withheld. Ask again or narrow the question.";
  }
  return response.message;
}

export function LessonTutor({
  lessonId,
  position,
  onSeek,
}: {
  lessonId: string;
  position: number;
  onSeek: (time: number) => void;
}) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, boolean>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      try {
        const headers = authHeaders(data.session);
        const next = await getTutorStatus(headers ? { headers } : {});
        if (alive.current) setStatus(next);
      } catch {
        // The status card is optional; the ask path reports auth/configuration.
      }
    });
    return () => {
      alive.current = false;
    };
  }, []);

  async function ask(rawQuestion: string, mode: TutorMode = "question") {
    const trimmed = rawQuestion.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setClientError(null);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setClientError("Your session expired. Sign in again to use the tutor.");
        return;
      }
      const history = turns
        .slice(-2)
        .flatMap((turn) => {
          if (turn.response.status !== "answered") return [];
          return [
            { role: "user" as const, content: turn.question },
            { role: "assistant" as const, content: turn.response.answer },
          ];
        })
        .slice(-4);
      const payload: TutorRequest = {
        lessonId,
        positionSeconds: Math.max(0, position),
        question: trimmed,
        mode,
        history,
      };
      const headers = authHeaders(data.session);
      const response = await askLessonTutor(
        headers ? { data: payload, headers } : { data: payload },
      );
      if (alive.current) {
        setTurns((current) => [...current, { question: trimmed, response }]);
        setQuestion("");
      }
    } catch (error) {
      if (alive.current) {
        setClientError(
          error instanceof Error && error.message.includes("Unauthorized")
            ? "Your session expired. Sign in again to use the tutor."
            : "The tutor request could not be completed. No answer was fabricated.",
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function saveFeedback(exchangeId: string, helpful: boolean) {
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      const headers = authHeaders(data.session);
      const result = await setTutorFeedback(
        headers ? { data: { exchangeId, helpful }, headers } : { data: { exchangeId, helpful } },
      );
      if (result.ok) setFeedback((current) => ({ ...current, [exchangeId]: helpful }));
      else toast.error(result.message);
    } catch {
      toast.error("Feedback could not be saved.");
    }
  }

  function openCitation(citation: TutorCitation) {
    if (citation.locator.kind === "video") {
      onSeek(citation.locator.startSeconds);
      return;
    }
    const href = citationHref(citation);
    if (href && typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }

  const configured = status?.providers.filter((provider) => provider.configured) ?? [];
  const providerNames = configured.map((provider) =>
    provider.providerId === "gemini" ? "Gemini" : "Groq",
  );
  const latest = turns.at(-1);

  return (
    <section
      className="rounded-lg border border-primary/20 bg-paper p-5"
      aria-labelledby="tutor-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-primary">
            <Sparkles className="size-5" />
          </span>
          <div>
            <h2 id="tutor-heading" className="text-2xl">
              Grounded AI tutor
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Answers only from what you have reached in this lesson, with clickable sources.
            </p>
          </div>
        </div>
        <span className="rounded-full border px-2.5 py-1 text-[11px] text-muted-foreground">
          {status
            ? configured.length
              ? `${providerNames.join(" + ")} · ${status.embeddings.configured ? "hybrid retrieval" : "keyword fallback"}`
              : "AI keys not detected"
            : "Checking AI setup…"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void ask("Explain the covered material around this point simply.", "explain")
          }
        >
          Explain simply
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void ask("Summarize the key ideas covered so far.", "summary")}
        >
          Summarize so far
        </Button>
      </div>

      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="tutor-question" className="sr-only">
          Ask about the covered lesson material
        </label>
        <Textarea
          id="tutor-question"
          value={question}
          maxLength={1_000}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={`Ask about the lesson at ${formatPosition(position)} — future material is excluded.`}
          className="min-h-20 resize-y"
          disabled={busy}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            Position checked on the server · free providers only
          </span>
          <Button type="submit" size="sm" disabled={busy || !question.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Send />}
            {busy ? "Checking sources…" : "Ask tutor"}
          </Button>
        </div>
      </form>

      {clientError && (
        <p
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          {clientError}
        </p>
      )}

      <div className="mt-5 space-y-5" aria-live="polite">
        {!turns.length && !busy && (
          <p className="text-sm text-muted-foreground">
            Ask a question to get a cited answer, or use one of the study actions above.
          </p>
        )}
        {turns.map((turn, index) => (
          <article
            key={`${turn.question}-${index}`}
            className="border-t pt-4 first:border-t-0 first:pt-0"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              You asked · {turn.question}
            </p>
            {turn.response.status === "answered" ? (
              <>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">
                  {turn.response.answer}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {turn.response.citations.map((citation) => (
                    <button
                      key={`${citation.evidenceId}-${citation.locator.kind}`}
                      type="button"
                      onClick={() => openCitation(citation)}
                      disabled={!isOpenable(citation)}
                      className={cn(
                        "inline-flex max-w-full items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-left text-xs",
                        isOpenable(citation)
                          ? "hover:border-primary hover:text-primary"
                          : "opacity-70",
                      )}
                      title={citation.quote ?? citation.text.slice(0, 180)}
                    >
                      {citation.locator.kind === "video" ? (
                        <PlayCircle className="size-3.5 shrink-0" />
                      ) : (
                        <BookOpen className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">
                        {citation.title ?? citation.resourceKind.replaceAll("_", " ")} ·{" "}
                        {locatorText(citation)}
                        {citation.availability === "unknown"
                          ? " · reference (alignment unknown)"
                          : citation.availability === "always"
                            ? " · always-available reference"
                            : ""}
                      </span>
                      {citation.sourceUrl && <ExternalLink className="size-3 shrink-0" />}
                    </button>
                  ))}
                </div>
                {turn.response.citations.some((citation) => citation.quote) && (
                  <ul className="mt-3 space-y-2">
                    {turn.response.citations
                      .filter((citation) => citation.quote)
                      .map((citation) => (
                        <li
                          key={`${citation.evidenceId}-quote`}
                          className="flex gap-2 text-xs text-muted-foreground"
                        >
                          <Quote className="mt-0.5 size-3.5 shrink-0" />
                          <span className="line-clamp-2">{citation.quote}</span>
                        </li>
                      ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
                  <p className="text-[11px] text-muted-foreground">
                    {turn.response.providerId} / {turn.response.modelId} · {turn.response.retrieval}{" "}
                    retrieval
                    {turn.response.fallbackUsed ? " · fallback provider used" : ""} ·{" "}
                    {Math.round(turn.response.latencyMs)} ms
                  </p>
                  {turn.response.exchangeId && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      {feedback[turn.response.exchangeId] === undefined ? (
                        <>
                          <span className="mr-1">Helpful?</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              const id = exchangeIdOf(turn.response);
                              if (id) void saveFeedback(id, true);
                            }}
                          >
                            Yes
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => {
                              const id = exchangeIdOf(turn.response);
                              if (id) void saveFeedback(id, false);
                            }}
                          >
                            Not quite
                          </Button>
                        </>
                      ) : (
                        <span>Feedback saved</span>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : turn.response.status === "insufficient_evidence" ? (
              <p className="mt-2 flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700" />
                {turn.response.message}
              </p>
            ) : (
              <p
                className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
                role="alert"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                {errorCopy(turn.response)}
              </p>
            )}
          </article>
        ))}
        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Retrieving eligible evidence and asking a free provider…
          </p>
        )}
        {latest?.response.status === "error" && latest.response.retryAfterSeconds && (
          <p className="text-xs text-muted-foreground">
            Retry window: about {latest.response.retryAfterSeconds}s. No paid fallback is enabled.
          </p>
        )}
      </div>
    </section>
  );
}
