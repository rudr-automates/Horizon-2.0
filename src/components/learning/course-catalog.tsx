import { Link } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowUpRight, CheckCircle2, Play, Search, Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { WorkspaceHeader } from "./workspace-header";
import { catalogQuery, progressQuery } from "@/lib/learning-queries";
import { courseCompletion, formatPosition } from "@/lib/learning";
import cover from "@/assets/embeddings.jpg.asset.json";

export function CourseCatalog({ userId, library = false }: { userId: string; library?: boolean }) {
  const { data: catalog } = useSuspenseQuery(catalogQuery);
  const { data: progress } = useSuspenseQuery(progressQuery(userId));
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const matching = (text: string) => text.toLowerCase().includes(search.toLowerCase());
  const imports = catalog.lessons.filter((l) => !l.is_demo && matching(l.title));
  return (
    <div className="min-h-screen">
      <WorkspaceHeader userId={userId} />
      <main className="mx-auto max-w-6xl px-5 py-10">
        <p className="eyebrow">Your learning collection</p>
        <h1 className="mt-2 text-4xl sm:text-5xl">
          {library ? "Your library" : "Course collection"}
        </h1>
        <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-b pb-5">
          <div className="flex gap-1">
            {["all", "in-progress", "completed"].map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "secondary" : "ghost"}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f === "in-progress" ? "In progress" : "Completed"}
              </Button>
            ))}
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label="Search courses and lessons"
              placeholder="Search your collection"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-7 grid gap-6 md:grid-cols-2">
          {catalog.courses
            .filter((c) => matching(c.title))
            .map((c) => {
              const lessons = catalog.lessons.filter((l) => l.course_id === c.id);
              const pct = courseCompletion(
                lessons.map((l) => l.id),
                progress,
              );
              if (
                (filter === "completed" && pct !== 100) ||
                (filter === "in-progress" &&
                  (pct === 100 || !progress.some((p) => lessons.some((l) => l.id === p.lesson_id))))
              )
                return null;
              const recent = progress.find(
                (p) => lessons.some((l) => l.id === p.lesson_id) && !p.completed,
              );
              const next =
                lessons.find((l) => l.id === recent?.lesson_id) ||
                lessons.find((l) => !progress.some((p) => p.lesson_id === l.id && p.completed)) ||
                lessons[0];
              return (
                <article className="overflow-hidden rounded-lg border bg-paper" key={c.id}>
                  <Link to="/courses/$courseId" params={{ courseId: c.id }}>
                    <img
                      src={cover.url}
                      alt="Original lesson: what is an embedding?"
                      className="aspect-video w-full object-cover"
                    />
                  </Link>
                  <div className="p-5">
                    <div className="flex justify-between text-xs">
                      <span className="text-primary">{c.category}</span>
                      <span className="text-muted-foreground">Demonstration course</span>
                    </div>
                    <h2 className="mt-3 text-2xl">
                      <Link to="/courses/$courseId" params={{ courseId: c.id }}>
                        {c.title}
                      </Link>
                    </h2>
                    <p className="mt-3 text-sm text-muted-foreground">
                      {lessons.length} lessons ·{" "}
                      {formatPosition(lessons.reduce((n, l) => n + l.duration_seconds, 0))} total
                    </p>
                    <Progress value={pct} className="mt-5" />
                    <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                      <span>{pct}% complete</span>
                      <span>
                        {
                          progress.filter(
                            (p) => p.completed && lessons.some((l) => l.id === p.lesson_id),
                          ).length
                        }
                        /{lessons.length} lessons
                      </span>
                    </div>
                    <div className="mt-5 flex justify-between gap-2">
                      <Button variant="ghost" asChild>
                        <Link to="/courses/$courseId" params={{ courseId: c.id }}>
                          Course details
                          <ArrowUpRight />
                        </Link>
                      </Button>
                      {next && (
                        <Button asChild>
                          <Link to="/learn/$lessonId" params={{ lessonId: next.id }}>
                            {pct === 100 ? <CheckCircle2 /> : <Play />}
                            {recent ? "Continue" : "Start learning"}
                          </Link>
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          {imports
            .filter((l) => {
              const p = progress.find((p) => p.lesson_id === l.id);
              return (
                filter === "all" || (filter === "completed" ? p?.completed : p && !p.completed)
              );
            })
            .map((l) => (
              <article key={l.id} className="rounded-lg border bg-paper p-6">
                <Film className="size-8 text-forest" />
                <p className="mt-4 text-xs text-muted-foreground">
                  Your imported video · {l.provider}
                </p>
                <h2 className="mt-2 break-words text-2xl">{l.title}</h2>
                <p className="mt-3 text-sm text-muted-foreground">
                  Transcript {l.transcript_status}
                </p>
                <Button className="mt-6" asChild>
                  <Link to="/learn/$lessonId" params={{ lessonId: l.id }}>
                    Open lesson
                    <ArrowUpRight />
                  </Link>
                </Button>
              </article>
            ))}
        </div>
        {!catalog.courses.some((c) => matching(c.title)) && !imports.length && (
          <p className="py-12 text-center text-muted-foreground">No matching courses or lessons.</p>
        )}
      </main>
    </div>
  );
}
