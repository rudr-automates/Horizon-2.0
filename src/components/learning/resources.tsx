import { FileText, Presentation, Code2, Download, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import guide from "@/assets/study-guide.pdf.asset.json";
import slides from "@/assets/course-slides.pptx.asset.json";

const resources = [
  { title: "The grounded AI study guide", detail: "PDF · 3 pages", icon: FileText, url: guide.url },
  {
    title: "From vectors to evidence",
    detail: "PowerPoint · 9 slides",
    icon: Presentation,
    url: slides.url,
  },
  { title: "Course notes", detail: "Markdown", icon: BookOpen, url: "/sample/course-notes.md" },
  {
    title: "Reciprocal rank fusion",
    detail: "Python · original example",
    icon: Code2,
    url: "/sample/hybrid-search.py",
  },
];
export function CourseResources() {
  return (
    <ul className="divide-y">
      {resources.map((r) => (
        <li key={r.title} className="flex items-center gap-3 py-4">
          <r.icon className="size-5 shrink-0 text-forest" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{r.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
          </div>
          <Button asChild size="icon" variant="ghost" title={`Download ${r.title}`}>
            <a
              href={r.url}
              download
              target="_blank"
              rel="noreferrer"
              aria-label={`Download ${r.title}`}
            >
              <Download />
            </a>
          </Button>
        </li>
      ))}
    </ul>
  );
}
