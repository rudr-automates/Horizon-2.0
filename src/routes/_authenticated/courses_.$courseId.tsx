import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Play, CheckCircle2, ArrowLeft } from "lucide-react";
import { catalogQuery, progressQuery } from "@/lib/learning-queries";
import { courseCompletion, formatPosition } from "@/lib/learning";
import { WorkspaceHeader } from "@/components/learning/workspace-header";
import { CourseResources } from "@/components/learning/resources";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
export const Route = createFileRoute("/_authenticated/courses_/$courseId")({
  head: () => ({
    meta: [
      { title: "Course outline & resources — Horizon 2.0" },
      {
        name: "description",
        content: "Lessons, objectives and resources for your grounded AI course.",
      },
      { property: "og:title", content: "Course outline & resources — Horizon 2.0" },
      {
        property: "og:description",
        content: "Explore the lesson outline and download matching study materials.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async ({ context, params }) => {
    const [catalog] = await Promise.all([
      context.queryClient.ensureQueryData(catalogQuery),
      context.queryClient.ensureQueryData(progressQuery(context.user.id)),
    ]);
    if (!catalog.courses.some((c) => c.id === params.courseId)) throw notFound();
  },
  component: Course,
});
function Course() {
  const { user } = Route.useRouteContext();
  const { courseId } = Route.useParams();
  const { data: catalog } = useSuspenseQuery(catalogQuery),
    { data: progress } = useSuspenseQuery(progressQuery(user.id));
  const course = catalog.courses.find((c) => c.id === courseId);
  if (!course) return null;
  const lessons = catalog.lessons.filter((l) => l.course_id === course.id);
  const pct = courseCompletion(
    lessons.map((l) => l.id),
    progress,
  );
  return (
    <div className="min-h-screen">
      <WorkspaceHeader userId={user.id} />
      <main className="mx-auto max-w-6xl px-5 py-8">
        <Button variant="ghost" asChild>
          <Link to="/courses">
            <ArrowLeft />
            Courses
          </Link>
        </Button>
        <p className="eyebrow mt-7">{course.category} · Demonstration course</p>
        <h1 className="mt-3 max-w-4xl text-4xl sm:text-5xl">{course.title}</h1>
        <p className="mt-5 max-w-3xl text-muted-foreground">{course.description}</p>
        <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_340px]">
          <section>
            <div className="flex justify-between">
              <h2 className="text-2xl">Lesson outline</h2>
              <span className="text-sm text-muted-foreground">{pct}% complete</span>
            </div>
            <Progress className="mt-3" value={pct} />
            <ol className="mt-4 divide-y">
              {lessons.map((l, i) => (
                <li key={l.id} className="flex items-center gap-4 py-6">
                  <span className="font-display text-3xl text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xl">{l.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{l.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {formatPosition(l.duration_seconds)} · Video & transcript
                    </p>
                  </div>
                  <Button variant="outline" size="icon" asChild title={`Open ${l.title}`}>
                    <Link
                      to="/learn/$lessonId"
                      params={{ lessonId: l.id }}
                      aria-label={`Open ${l.title}`}
                    >
                      {progress.some((p) => p.lesson_id === l.id && p.completed) ? (
                        <CheckCircle2 />
                      ) : (
                        <Play />
                      )}
                    </Link>
                  </Button>
                </li>
              ))}
            </ol>
            <h2 className="mt-8 text-2xl">Learning objectives</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-sm">
              {course.objectives.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </section>
          <aside>
            <h2 className="text-2xl">Course resources</h2>
            <CourseResources />
          </aside>
        </div>
      </main>
    </div>
  );
}
