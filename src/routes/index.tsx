import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BookOpen,
  CalendarDays,
  CheckSquare,
  FileText,
  Code2,
  Film,
  Presentation,
  Quote,
  ShieldCheck,
  Timer,
  Target,
  Network,
  Sparkles,
  ListChecks,
  GraduationCap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SiteHeader, Logo } from "@/components/site-header";
import hero from "@/assets/hero-graph.jpg";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Horizon 2.0 — Learning that understands your context" },
      {
        name: "description",
        content:
          "Bring videos, documents, notes and code into one workspace. Ask evidence-grounded questions and turn learning into measurable progress.",
      },
      { property: "og:title", content: "Horizon 2.0 — Learning that understands your context" },
      {
        property: "og:description",
        content:
          "One learning workspace for your videos, documents, notes and code, with cited answers and a real study plan.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

const sources = [
  { icon: Film, label: "Video lessons", note: "Timestamped transcripts" },
  { icon: FileText, label: "PDFs", note: "Page-level citations" },
  { icon: Presentation, label: "Slides", note: "Slide-by-slide context" },
  { icon: BookOpen, label: "Notes", note: "Markdown & plain text" },
  { icon: Code2, label: "Code", note: "Supported source files" },
];

const modes = [
  {
    title: "Learn",
    body: "Ask about what you're studying. Answers cite the exact video moment, page or slide — and never peek ahead of where you are.",
    icon: GraduationCap,
  },
  {
    title: "Verify & Improve",
    body: "Quizzes generated from your materials, with explanations that point back to the evidence.",
    icon: ListChecks,
  },
  {
    title: "Prepare",
    body: "Practice for exams and interviews using the concepts you've actually covered.",
    icon: Target,
  },
];

const steps = [
  "Add a course, a video link, or your own files.",
  "Horizon indexes each source with its location and permissions.",
  "Study with a tutor that shows its evidence.",
  "Gaps become tasks, sessions and goals on your plan.",
];

const faqs = [
  {
    q: "Is Horizon a course marketplace?",
    a: "No. Marketplaces sell content. Horizon is a workspace that connects the content you have — bought, provided by your instructor, or your own — and helps you understand and plan around it.",
  },
  {
    q: "Will the AI make things up?",
    a: "No AI is perfect. Horizon grounds answers in your sources, links every citation to real content, and will narrow or decline an answer when evidence is thin.",
  },
  {
    q: "What does 'position-aware' mean?",
    a: "When you're 12 minutes into a lesson, the tutor only uses the video up to 12 minutes, so it won't spoil or confuse with later material unless you widen the scope.",
  },
  {
    q: "Who can see my tasks and notes?",
    a: "Only you. Every personal record is tied to your account and protected on the server.",
  },
];

function Landing() {
  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 md:grid-cols-[1.05fr_1fr] md:py-24">
          <div>
            <p className="eyebrow">The ContextGraph learning workspace</p>
            <h1 className="mt-4 text-5xl leading-[1.05] font-medium md:text-6xl">
              Learning that <em className="text-primary">understands</em> your context.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              Bring your videos, documents, notes, and code into one learning workspace. Ask
              evidence-grounded questions, connect ideas across resources, and turn learning into
              measurable progress.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/sign-up">Start learning</Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#demo">Explore the demo</a>
              </Button>
            </div>
          </div>
          <img
            src={hero}
            width={1280}
            height={1024}
            alt="Illustrated network connecting a book, a video, a slide and code"
            className="paper-card w-full"
          />
        </section>

        <section id="product" className="border-y bg-paper">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <p className="eyebrow">ContextGraph</p>
            <h2 className="mt-3 max-w-2xl text-4xl">
              One knowledge layer across everything you study.
            </h2>
            <p className="mt-4 max-w-2xl text-muted-foreground">
              Reading a slide about embeddings? Jump to the moment it's explained in the lecture,
              the PDF page that goes deeper, and the code that puts it to work.
            </p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {sources.map((s) => (
                <div key={s.label} className="paper-card p-5">
                  <s.icon className="text-forest" />
                  <p className="mt-4 font-display text-lg">{s.label}</p>
                  <p className="text-sm text-muted-foreground">{s.note}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="demo" className="mx-auto grid max-w-6xl gap-10 px-5 py-20 md:grid-cols-2">
          <div>
            <p className="eyebrow">Evidence you can open</p>
            <h2 className="mt-3 text-4xl">Every answer shows its sources.</h2>
            <p className="mt-4 text-muted-foreground">
              Citations resolve to a real transcript moment, page or slide. When the evidence isn't
              there, Horizon says so instead of guessing.
            </p>
          </div>
          <div className="paper-card space-y-4 p-6">
            <p className="text-xs text-muted-foreground">
              Scope: <span className="font-semibold text-forest">Lesson 3 · up to 12:40</span> ·
              demonstration
            </p>
            <p className="rounded-lg bg-muted p-3 text-sm">
              Why do we normalise embeddings before cosine similarity?
            </p>
            <p className="text-sm leading-relaxed">
              Normalising puts every vector on the unit sphere, so the dot product equals cosine
              similarity and length no longer skews results{" "}
              <span className="rounded bg-accent px-1.5 text-accent-foreground">[1]</span>. The
              lecture shows this with two short sentences{" "}
              <span className="rounded bg-accent px-1.5 text-accent-foreground">[2]</span>.
            </p>
            <div className="space-y-2 border-t pt-3 text-xs">
              <p className="flex items-center gap-2">
                <Quote className="size-3.5 text-primary" />
                [1] Vector Search Basics.pdf — page 4
              </p>
              <p className="flex items-center gap-2">
                <Film className="size-3.5 text-primary" />
                [2] Lesson 3 video — 11:52
              </p>
            </div>
          </div>
        </section>

        <section id="modes" className="border-y bg-secondary/50">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <p className="eyebrow">Learning modes</p>
            <h2 className="mt-3 text-4xl">Learn. Verify. Prepare.</h2>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {modes.map((m) => (
                <div key={m.title} className="paper-card p-6">
                  <m.icon className="text-primary" />
                  <h3 className="mt-4 text-2xl">{m.title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{m.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-20">
          <p className="eyebrow">From learning to action</p>
          <h2 className="mt-3 max-w-2xl text-4xl">Your plan lives next to your studies.</h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: CalendarDays, t: "Calendar", d: "Plan study sessions by week or month." },
              { icon: CheckSquare, t: "Tasks", d: "Priorities, due dates and tags." },
              {
                icon: Timer,
                t: "Focus timer",
                d: "Sessions recorded honestly, even in background tabs.",
              },
              { icon: Sparkles, t: "Streaks & goals", d: "Built from what you actually did." },
            ].map((f) => (
              <div key={f.t} className="border-l-2 border-primary pl-4">
                <f.icon className="text-forest" />
                <p className="mt-3 font-display text-lg">{f.t}</p>
                <p className="text-sm text-muted-foreground">{f.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="how" className="border-y bg-paper">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <p className="eyebrow">How it works</p>
            <h2 className="mt-3 text-4xl">From adding content to verified understanding.</h2>
            <ol className="mt-10 grid gap-6 md:grid-cols-4">
              {steps.map((s, i) => (
                <li key={s}>
                  <span className="font-display text-5xl text-primary/70">0{i + 1}</span>
                  <p className="mt-2">{s}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="about" className="mx-auto grid max-w-6xl gap-10 px-5 py-20 md:grid-cols-2">
          <div>
            <ShieldCheck className="size-8 text-forest" />
            <h2 className="mt-3 text-4xl">Transparent by design.</h2>
            <p className="mt-4 text-muted-foreground">
              Your personal records stay private to your account. Sources keep their origin and
              permissions. AI status is shown honestly — never faked.
            </p>
            <Network className="mt-8 size-6 text-primary" />
          </div>
          <Accordion type="single" collapsible>
            {faqs.map((f) => (
              <AccordionItem key={f.q} value={f.q}>
                <AccordionTrigger className="text-left font-display text-lg">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        <section className="bg-forest text-forest-foreground">
          <div className="mx-auto max-w-6xl px-5 py-20 text-center">
            <h2 className="text-4xl md:text-5xl">Start building your horizon.</h2>
            <Button size="lg" className="mt-8" asChild>
              <Link to="/sign-up">Create your workspace</Link>
            </Button>
          </div>
        </section>
      </main>
      <footer className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 text-sm text-muted-foreground md:flex-row">
        <Logo />
        <p>© {new Date().getFullYear()} Horizon 2.0</p>
      </footer>
    </div>
  );
}
