import { createFileRoute } from "@tanstack/react-router";
import { CourseCatalog } from "@/components/learning/course-catalog";
import { catalogQuery, progressQuery } from "@/lib/learning-queries";
export const Route = createFileRoute("/_authenticated/courses")({
  head: () => ({
    meta: [
      { title: "Course collection — Horizon 2.0" },
      { name: "description", content: "Explore grounded AI lessons and track your learning." },
      { property: "og:title", content: "Course collection — Horizon 2.0" },
      {
        property: "og:description",
        content: "Explore original lessons and matching study resources.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(catalogQuery),
      context.queryClient.ensureQueryData(progressQuery(context.user.id)),
    ]);
  },
  component: Courses,
});
function Courses() {
  const { user } = Route.useRouteContext();
  return <CourseCatalog userId={user.id} />;
}
