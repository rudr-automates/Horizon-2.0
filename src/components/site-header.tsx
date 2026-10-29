import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUser } from "@/lib/use-user";
import { supabase } from "@/integrations/supabase/client";

export function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2" aria-label="Horizon 2.0 home">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
        <circle
          cx="16"
          cy="16"
          r="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-forest"
        />
        <path d="M3 19h26" stroke="currentColor" strokeWidth="1.5" className="text-forest" />
        <circle cx="16" cy="19" r="6" className="fill-primary" />
      </svg>
      <span className="font-display text-xl font-semibold">
        Horizon<span className="text-primary"> 2.0</span>
      </span>
    </Link>
  );
}

const links = [
  { href: "#product", label: "Product" },
  { href: "#how", label: "How it works" },
  { href: "#modes", label: "Learning modes" },
  { href: "#about", label: "About" },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const { user } = useUser();
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Logo />
        <nav className="hidden items-center gap-7 text-sm md:flex">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="text-muted-foreground hover:text-foreground">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          {user ? (
            <>
              <Button
                variant="ghost"
                onClick={async () => {
                  await supabase.auth.signOut();
                  navigate({ to: "/", replace: true });
                }}
              >
                Sign out
              </Button>
              <Button asChild>
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" asChild>
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild>
                <Link to="/sign-up">Get started</Link>
              </Button>
            </>
          )}
        </div>
        <button className="md:hidden" onClick={() => setOpen(!open)} aria-label="Toggle menu">
          {open ? <X /> : <Menu />}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t px-5 py-4 md:hidden">
          {links.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block">
              {l.label}
            </a>
          ))}
          <div className="flex gap-2 pt-2">
            {user ? (
              <Button asChild className="flex-1">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            ) : (
              <>
                <Button variant="outline" asChild className="flex-1">
                  <Link to="/sign-in">Sign in</Link>
                </Button>
                <Button asChild className="flex-1">
                  <Link to="/sign-up">Get started</Link>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
