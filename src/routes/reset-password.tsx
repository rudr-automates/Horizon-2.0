import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Choose a new password — Horizon 2.0" },
      { name: "description", content: "Set a new password for your Horizon account." },
      { property: "og:title", content: "Choose a new password — Horizon 2.0" },
      { property: "og:description", content: "Set a new password for your Horizon account." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Reset,
});

function Reset() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    if (password.length < 8) {
      toast.error("Use at least 8 characters.");
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Password updated");
    navigate({ to: "/dashboard" });
  }
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <PasswordInput id="password" name="password" required autoComplete="new-password" />
        </div>
        <Button className="w-full" disabled={busy}>
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
