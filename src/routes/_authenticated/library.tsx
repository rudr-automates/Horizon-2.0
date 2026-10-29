import { createFileRoute } from "@tanstack/react-router";
import { CourseCatalog } from "@/components/learning/course-catalog";
import { catalogQuery, progressQuery } from "@/lib/learning-queries";
export const Route = createFileRoute("/_authenticated/library")({
  head: () => ({
    meta: [
      { title: "Your library — Horizon 2.0" },
      {
        name: "description",
        content: "Your courses and imported video lessons in one collection.",
      },
      { property: "og:title", content: "Your library — Horizon 2.0" },
      {
        property: "og:description",
        content: "Revisit your learning collection and saved progress.",
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
  component: Library,
});
function Library() {
  const { user } = Route.useRouteContext();
  return <CourseCatalog userId={user.id} library />;
}
