import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({
    meta: [
      { title: "Set up your workspace — Horizon 2.0" },
      { name: "description", content: "Tell Horizon how you like to learn." },
      { property: "og:title", content: "Set up — Horizon 2.0" },
      { property: "og:description", content: "Tell Horizon how you like to learn." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Onboarding,
});

type P = {
  display_name: string;
  goals: string;
  experience_level: string;
  explanation_style: string;
  main_objective: string;
  weekly_target_minutes: number;
  study_days: string[];
  study_hours: string;
  target_date: string;
};
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STEPS = ["About you", "Your objective", "How you learn", "Your schedule"];

function Chips({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          type="button"
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            "rounded-full border px-3 py-1.5 text-sm",
            value === o ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Onboarding() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [p, setP] = useState<P | null>(null);

  useEffect(() => {
    supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data }) => {
        setP({
          display_name: data?.display_name ?? "",
          goals: data?.goals ?? "",
          experience_level: data?.experience_level ?? "",
          explanation_style: data?.explanation_style ?? "",
          main_objective: data?.main_objective ?? "",
          weekly_target_minutes: data?.weekly_target_minutes ?? 300,
          study_days: data?.study_days ?? [],
          study_hours: data?.study_hours ?? "",
          target_date: data?.target_date ?? "",
        });
        setStep(Math.min(data?.onboarding_completed ? 0 : (data?.onboarding_step ?? 0), 3));
      });
  }, [user.id]);

  if (!p) return null;
  const set = <K extends keyof P>(k: K, v: P[K]) => setP({ ...p, [k]: v });

  async function save(next: number, done = false) {
    if (!p) return;
    const { error } = await supabase.from("profiles").upsert({
      id: user.id,
      ...p,
      target_date: p.target_date || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      onboarding_step: next,
      ...(done ? { onboarding_completed: true } : {}),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    if (done) navigate({ to: "/dashboard" });
    else setStep(next);
  }

  return (
    <AuthShell title={STEPS[step] ?? ""} subtitle={`Step ${step + 1} of ${STEPS.length}`}>
      <Progress value={((step + 1) / STEPS.length) * 100} className="mb-6" />
      <div className="space-y-5">
        {step === 0 && (
          <>
            <div className="space-y-1.5">
              <Label>Display name</Label>
              <Input value={p.display_name} onChange={(e) => set("display_name", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Experience level</Label>
              <Chips
                options={["Beginner", "Intermediate", "Advanced"]}
                value={p.experience_level}
                onChange={(v) => set("experience_level", v)}
              />
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <div className="space-y-1.5">
              <Label>Main objective</Label>
              <Chips
                options={[
                  "Course learning",
                  "Exam revision",
                  "Skill development",
                  "Interview preparation",
                ]}
                value={p.main_objective}
                onChange={(v) => set("main_objective", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Learning goals</Label>
              <Textarea
                value={p.goals}
                onChange={(e) => set("goals", e.target.value)}
                placeholder="e.g. Understand vector databases well enough to build a search app"
              />
            </div>
          </>
        )}
        {step === 2 && (
          <div className="space-y-1.5">
            <Label>Preferred explanation style</Label>
            <Chips
              options={["Concise", "Step-by-step", "Examples first", "Analogies"]}
              value={p.explanation_style}
              onChange={(v) => set("explanation_style", v)}
            />
          </div>
        )}
        {step === 3 && (
          <>
            <div className="space-y-1.5">
              <Label>Weekly study target (hours)</Label>
              <Input
                type="number"
                min={1}
                max={80}
                value={Math.round(p.weekly_target_minutes / 60)}
                onChange={(e) => set("weekly_target_minutes", Number(e.target.value) * 60)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Study days</Label>
              <div className="flex flex-wrap gap-2">
                {DAYS.map((d) => {
                  const on = p.study_days.includes(d);
                  return (
                    <button
                      type="button"
                      key={d}
                      onClick={() =>
                        set(
                          "study_days",
                          on ? p.study_days.filter((x) => x !== d) : [...p.study_days, d],
                        )
                      }
                      className={cn(
                        "w-12 rounded-md border py-1.5 text-sm",
                        on ? "border-forest bg-forest text-forest-foreground" : "hover:bg-muted",
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Preferred hours</Label>
              <Chips
                options={["Morning", "Afternoon", "Evening", "Late night"]}
                value={p.study_hours}
                onChange={(v) => set("study_hours", v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Target date (optional)</Label>
              <Input
                type="date"
                value={p.target_date}
                onChange={(e) => set("target_date", e.target.value)}
              />
            </div>
          </>
        )}
      </div>
      <div className="mt-8 flex justify-between gap-2">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        <div className="flex gap-2">
          {step > 0 && step < 3 && (
            <Button variant="outline" onClick={() => save(step + 1)}>
              Skip
            </Button>
          )}
          {step < 3 ? (
            <Button onClick={() => save(step + 1)}>Continue</Button>
          ) : (
            <Button onClick={() => save(3, true)}>Finish</Button>
          )}
        </div>
      </div>
    </AuthShell>
  );
}
