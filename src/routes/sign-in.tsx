import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { safeRedirect } from "@/lib/use-user";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (s: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: typeof s["redirect"] === "string" ? (s["redirect"] as string) : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Sign in — Horizon 2.0" },
      { name: "description", content: "Sign in to your Horizon learning workspace." },
      { property: "og:title", content: "Sign in — Horizon 2.0" },
      { property: "og:description", content: "Sign in to your Horizon learning workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SignIn,
});

function SignIn() {
  const { redirect } = Route.useSearch();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    navigate({ to: safeRedirect(redirect) });
  }
  return (
    <AuthShell title="Welcome back" subtitle="Pick up where you left off.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-xs text-primary">
              Forgot password?
            </Link>
          </div>
          <PasswordInput id="password" name="password" required autoComplete="current-password" />
        </div>
        <Button className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link to="/sign-up" className="text-primary">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
