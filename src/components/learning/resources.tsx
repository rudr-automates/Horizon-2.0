import { FileText, Presentation, Code2, Download, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

// Every entry is a file this repository actually serves. The previous list
// pointed at preview-hosted assets that no longer resolve outside that preview.
const resources = [
  {
    title: "MIT 15.773 lecture 1 slides",
    detail: "PDF · course handout",
    icon: FileText,
    url: "/course/mit-15-773/mit15_773_s24_lec01.pdf",
  },
  {
    title: "MIT 15.773 backpropagation example",
    detail: "PDF · worked example",
    icon: Presentation,
    url: "/course/mit-15-773/mit15_773_s24_lec02_backprop_example.pdf",
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
