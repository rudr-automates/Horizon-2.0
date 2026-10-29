import { createFileRoute } from "@tanstack/react-router";
import { Studio } from "@/components/learning/studio";
import { annotationsQuery, catalogQuery, lessonQuery, progressQuery } from "@/lib/learning-queries";
export const Route = createFileRoute("/_authenticated/learn/$lessonId")({
  head: () => ({
    meta: [
      { title: "Learning Studio — Horizon 2.0" },
      {
        name: "description",
        content: "Watch a lesson with synced captions, timestamped notes and study resources.",
      },
      { property: "og:title", content: "Learning Studio — Horizon 2.0" },
      {
        property: "og:description",
        content: "A focused workspace for video lessons, transcripts and personal notes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(lessonQuery(params.lessonId)),
      context.queryClient.ensureQueryData(catalogQuery),
      context.queryClient.ensureQueryData(progressQuery(context.user.id)),
      context.queryClient.ensureQueryData(annotationsQuery(params.lessonId, context.user.id)),
    ]);
  },
  component: Lesson,
});
function Lesson() {
  const { user } = Route.useRouteContext();
  const { lessonId } = Route.useParams();
  return <Studio key={lessonId} lessonId={lessonId} userId={user.id} />;
}
