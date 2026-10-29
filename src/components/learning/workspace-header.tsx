import { Link } from "@tanstack/react-router";
import { BookOpen, LayoutDashboard } from "lucide-react";
import { Logo } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { ImportVideo } from "./import-video";

export function WorkspaceHeader({ userId }: { userId: string }) {
  return (
    <header className="border-b bg-paper">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
        <Logo />
        <nav className="flex flex-wrap items-center gap-1" aria-label="Workspace">
          <Button variant="ghost" asChild>
            <Link to="/dashboard">
              <LayoutDashboard />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/courses">
              <BookOpen />
              <span className="hidden sm:inline">Courses</span>
            </Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/library">Library</Link>
          </Button>
          <ImportVideo userId={userId} />
        </nav>
      </div>
    </header>
  );
}
