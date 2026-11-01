import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ClientOnly, Link } from "@tanstack/react-router";
import { useSuspenseQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, BookOpen, Clock } from "lucide-react";
import { toast } from "sonner";
import { lessonQuery, catalogQuery, progressQuery } from "@/lib/learning-queries";
import { formatPosition, courseCompletion } from "@/lib/learning";
import { supabase } from "@/integrations/supabase/client";
import { useVideoIngestion } from "@/hooks/use-video-ingestion";
import { WorkspaceHeader } from "./workspace-header";
import { TranscriptPanel } from "./transcript-panel";
import { Annotations } from "./annotations";
import { LessonResources } from "./lesson-resources";
import { LessonTutor } from "./lesson-tutor";
import { LessonPractice } from "./lesson-practice";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const LessonPlayer = lazy(() =>
  import("./lesson-player").then((m) => ({ default: m.LessonPlayer })),
);
export function Studio({ lessonId, userId }: { lessonId: string; userId: string }) {
  const { data: lesson } = useSuspenseQuery(lessonQuery(lessonId)),
    { data: catalog } = useSuspenseQuery(catalogQuery),
    { data: progress } = useSuspenseQuery(progressQuery(userId));
  const qc = useQueryClient();
  const saved = progress.find((p) => p.lesson_id === lessonId);
  const [position, setPosition] = useState(saved?.position_seconds || 0),
    [duration, setDuration] = useState(lesson.duration_seconds),
    [seek, setSeek] = useState<{ time: number; key: number } | null>(null),
    [saveState, setSaveState] = useState("Saved"),
    [pending, setPending] = useState(false);
  const state = useRef({
    position: saved?.position_seconds || 0,
    watched: saved?.watched_seconds || 0,
    completed: saved?.completed || false,
    dirty: false,
  });
  const inFlight = useRef<Promise<void> | null>(null),
    alive = useRef(true),
    durationPersisted = useRef(false);
  // Uploaded and imported videos start with an unknown duration, and the tutor
  // refuses to rank evidence against an unknown duration. Record what the
  // player reports once, so position-aware retrieval works for those lessons.
  const onDuration = useCallback(
    (next: number) => {
      setDuration(next);
      if (!Number.isFinite(next) || next < 1 || durationPersisted.current) return;
      const seconds = Math.round(next);
      if (Math.abs(seconds - lesson.duration_seconds) < 1) {
        durationPersisted.current = true;
        return;
      }
      durationPersisted.current = true;
      void supabase
        .from("lessons")
        .update({ duration_seconds: seconds })
        .eq("id", lessonId)
        .then(({ error }) => {
          if (error) {
            durationPersisted.current = false;
            return;
          }
          void qc.invalidateQueries({ queryKey: ["learning", "lesson", lessonId] });
          void qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
        });
    },
    [lesson.duration_seconds, lessonId, qc],
  );
  // Every lesson without an indexed transcript is processed automatically, so
  // the tutor, simplifier, summariser and practice quiz work on any video, not
  // only the seeded course. Demo lessons are already indexed and are skipped.
  const ingestion = useVideoIngestion({
    lessonId,
    enabled: !lesson.is_demo,
    onReady: () => {
      void qc.invalidateQueries({ queryKey: ["learning", "lesson", lessonId] });
      void qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
    },
  });
  const lessons = lesson.course_id
    ? catalog.lessons.filter((l) => l.course_id === lesson.course_id)
    : [lesson];
  const index = lessons.findIndex((l) => l.id === lesson.id),
    next = lessons[index + 1];
  const course = catalog.courses.find((c) => c.id === lesson.course_id);
  const pct = courseCompletion(
    lessons.map((l) => l.id),
    progress,
  );
  const checkpoint = useCallback(async () => {
    if (inFlight.current) await inFlight.current;
    if (!state.current.dirty) return;
    const snapshot = { ...state.current };
    state.current.dirty = false;
    if (alive.current) setSaveState("Saving…");
    const write = async () => {
      try {
        const { error } = await supabase.from("lesson_progress").upsert(
          {
            user_id: userId,
            lesson_id: lessonId,
            position_seconds: snapshot.position,
            watched_seconds: snapshot.watched,
            completed: snapshot.completed,
          },
          { onConflict: "user_id,lesson_id" },
        );
        if (error) throw error;
        if (alive.current) setSaveState("Saved");
        await qc.invalidateQueries({ queryKey: ["learning", "progress", userId] });
      } catch {
        state.current.dirty = true;
        if (alive.current) setSaveState("Could not save");
      }
    };
    inFlight.current = write();
    await inFlight.current;
    inFlight.current = null;
  }, [lessonId, userId, qc]);
  useEffect(() => {
    alive.current = true;
    const interval = setInterval(() => void checkpoint(), 10000);
    const hide = () => {
      if (document.visibilityState === "hidden") void checkpoint();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      alive.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", hide);
      void checkpoint();
    };
  }, [checkpoint]);
  const onPosition = (time: number, watched: number) => {
    state.current.position = time;
    state.current.watched += watched;
    state.current.dirty = true;
    setPosition(time);
  };
  const jump = (time: number) => setSeek({ time, key: Date.now() });
  async function toggleComplete() {
    if (pending) return;
    setPending(true);
    state.current.completed = !state.current.completed;
    state.current.dirty = true;
    await checkpoint();
    if (!state.current.dirty)
      toast.success(state.current.completed ? "Lesson marked complete" : "Lesson reopened");
    setPending(false);
  }
  return (
    <div className="min-h-screen">
      <WorkspaceHeader userId={userId} />
      <main className="mx-auto max-w-7xl px-5 py-7">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-5">
          <Button variant="ghost" asChild>
            {course ? (
              <Link to="/courses/$courseId" params={{ courseId: course.id }}>
                <ArrowLeft />
                <span className="max-w-64 truncate">{course.title}</span>
              </Link>
            ) : (
              <Link to="/library">
                <ArrowLeft />
                Your library
              </Link>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            {lesson.is_demo
              ? "Demonstration · original synthetic narration"
              : "Your private lesson"}{" "}
            · {saveState}
          </span>
        </div>
        <div className="mt-7 grid min-w-0 gap-7 xl:grid-cols-[minmax(0,1fr)_390px]">
          <section className="min-w-0">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="eyebrow">
                  Lesson {index + 1} of {lessons.length}
                </p>
                <h1 className="mt-2 break-words text-3xl sm:text-4xl">{lesson.title}</h1>
              </div>
              <BookOpen className="mt-7 size-6 shrink-0 text-forest" />
            </div>
            <ClientOnly fallback={<div className="aspect-video bg-muted" />}>
              <Suspense
                fallback={
                  <div className="flex aspect-video items-center justify-center bg-muted">
                    Loading video…
                  </div>
                }
              >
                <LessonPlayer
                  lesson={lesson}
                  initialPosition={saved?.position_seconds || 0}
                  seek={seek}
                  onPosition={onPosition}
                  onCheckpoint={() => void checkpoint()}
                  onDuration={onDuration}
                />
              </Suspense>
            </ClientOnly>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="size-4" />
                {formatPosition(position)} / {formatPosition(duration)}
              </span>
              <Button
                disabled={pending}
                variant={saved?.completed ? "secondary" : "outline"}
                onClick={toggleComplete}
              >
                <CheckCircle2 />
                {saved?.completed ? "Completed · reopen" : "Mark complete"}
              </Button>
            </div>
            <p className="mt-5 text-sm leading-6 text-muted-foreground">{lesson.description}</p>
            <div className="mt-7">
              <LessonTutor
                lessonId={lessonId}
                position={position}
                onSeek={jump}
                ingestion={ingestion.status}
              />
            </div>
            <div className="mt-7">
              <div className="flex items-center justify-between">
                <h2 className="text-2xl">{course ? "Course lessons" : "Lesson progress"}</h2>
                <span className="text-xs text-muted-foreground">{pct}% complete</span>
              </div>
              <Progress className="mt-3" value={pct} />
              <ol className="mt-3 divide-y">
                {lessons.map((l, i) => (
                  <li key={l.id}>
                    <Link
                      to="/learn/$lessonId"
                      params={{ lessonId: l.id }}
                      className={cn(
                        "flex items-center gap-3 py-4 text-sm",
                        l.id === lessonId && "text-primary",
                      )}
                      onClick={() => void checkpoint()}
                    >
                      {progress.some((p) => p.lesson_id === l.id && p.completed) ? (
                        <CheckCircle2 className="size-4 text-forest" />
                      ) : (
                        <Circle className="size-4" />
                      )}
                      <span className="min-w-0 flex-1">
                        {i + 1}. {l.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatPosition(l.duration_seconds)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
              {next && (
                <Button className="mt-5" asChild>
                  <Link
                    to="/learn/$lessonId"
                    params={{ lessonId: next.id }}
                    onClick={() => void checkpoint()}
                  >
                    Next lesson
                    <ArrowRight />
                  </Link>
                </Button>
              )}
            </div>
          </section>
          <aside className="min-w-0 border-t pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0">
            <Tabs defaultValue="transcript">
              <TabsList className="grid h-10 w-full grid-cols-5">
                <TabsTrigger value="transcript" className="px-1 text-xs">
                  Transcript
                </TabsTrigger>
                <TabsTrigger value="notes" className="px-1 text-xs">
                  Notes
                </TabsTrigger>
                <TabsTrigger value="bookmarks" className="px-1 text-xs">
                  Saved
                </TabsTrigger>
                <TabsTrigger value="resources" className="px-1 text-xs">
                  Resources
                </TabsTrigger>
                <TabsTrigger value="practice" className="px-1 text-xs">
                  Practice
                </TabsTrigger>
              </TabsList>
              <TabsContent value="transcript" className="mt-5">
                <TranscriptPanel
                  lesson={lesson}
                  position={position}
                  onSeek={jump}
                  ingestion={ingestion.status}
                  ingestionError={ingestion.error}
                  ingestionBusy={ingestion.busy}
                  onRetryIngestion={() => void ingestion.retry()}
                />
              </TabsContent>
              <TabsContent value="notes" className="mt-5">
                <Annotations
                  lessonId={lessonId}
                  userId={userId}
                  position={position}
                  onSeek={jump}
                  mode="notes"
                />
              </TabsContent>
              <TabsContent value="bookmarks" className="mt-5">
                <Annotations
                  lessonId={lessonId}
                  userId={userId}
                  position={position}
                  onSeek={jump}
                  mode="bookmarks"
                />
              </TabsContent>
              <TabsContent value="resources" className="mt-5">
                <h2 className="text-2xl">Study materials</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sources the tutor can cite from this lesson. Private uploads are visible only to
                  you.
                </p>
                <div className="mt-4">
                  <LessonResources lessonId={lessonId} courseId={lesson.course_id ?? undefined} />
                </div>
              </TabsContent>
              <TabsContent value="practice" className="mt-5">
                <LessonPractice lessonId={lessonId} position={position} onSeek={jump} />
              </TabsContent>
            </Tabs>
          </aside>
        </div>
      </main>
    </div>
  );
}
