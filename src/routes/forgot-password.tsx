import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Reset password — Horizon 2.0" },
      { name: "description", content: "Get a link to reset your Horizon password." },
      { property: "og:title", content: "Reset password — Horizon 2.0" },
      { property: "og:description", content: "Get a link to reset your Horizon password." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Forgot,
});

function Forgot() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(
      String(new FormData(e.currentTarget).get("email")),
      { redirectTo: `${window.location.origin}/reset-password` },
    );
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDone(true);
  }
  return (
    <AuthShell
      title="Forgot your password?"
      subtitle={
        done
          ? "If that email has an account, a reset link is on its way."
          : "We'll email you a reset link."
      }
    >
      {!done && (
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <Button className="w-full" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link to="/sign-in" search={{ redirect: undefined }} className="text-primary">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
