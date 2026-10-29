import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { MailCheck } from "lucide-react";
import { AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/sign-up")({
  head: () => ({
    meta: [
      { title: "Create your account — Horizon 2.0" },
      { name: "description", content: "Create a free Horizon learning workspace." },
      { property: "og:title", content: "Create your account — Horizon 2.0" },
      { property: "og:description", content: "Create a free Horizon learning workspace." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: SignUp,
});

function SignUp() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password.length < 8 || !/\d/.test(password) || !/[A-Za-z]/.test(password)) {
      toast.error("Use at least 8 characters with letters and a number.");
      return;
    }
    setBusy(true);
    const email = String(f.get("email"));
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: { display_name: String(f.get("name")) },
      },
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (data.session) window.location.assign("/onboarding");
    else setSent(email);
  }
  if (sent)
    return (
      <AuthShell title="Check your email">
        <MailCheck className="size-10 text-forest" />
        <p className="mt-4 text-sm text-muted-foreground">
          We sent a confirmation link to <strong>{sent}</strong>. Open it to activate your account.
        </p>
        <Button variant="outline" className="mt-6 w-full" asChild>
          <Link to="/sign-in">Back to sign in</Link>
        </Button>
      </AuthShell>
    );
  return (
    <AuthShell title="Create your workspace" subtitle="It takes less than a minute.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Display name</Label>
          <Input id="name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <PasswordInput id="password" name="password" required autoComplete="new-password" />
          <p className="text-xs text-muted-foreground">
            At least 8 characters, letters and a number.
          </p>
        </div>
        <Button className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link to="/sign-in" search={{ redirect: undefined }} className="text-primary">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
