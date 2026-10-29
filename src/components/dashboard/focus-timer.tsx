import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { remainingSeconds } from "@/lib/streak";
import { tasksQuery } from "./tasks-panel";

type State =
  | { mode: "idle" }
  | { mode: "running"; endsAt: number; startedAt: number; elapsedBefore: number; segStart: number }
  | { mode: "paused"; remaining: number; startedAt: number; elapsed: number };

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export function FocusTimer() {
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery(tasksQuery);
  const [minutes, setMinutes] = useState(25);
  const [taskId, setTaskId] = useState("none");
  const [state, setState] = useState<State>({ mode: "idle" });
  const [now, setNow] = useState(Date.now());
  const saving = useRef(false);

  useEffect(() => {
    if (state.mode !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [state.mode]);

  const left =
    state.mode === "running"
      ? remainingSeconds(state.endsAt, now)
      : state.mode === "paused"
        ? state.remaining
        : minutes * 60;

  async function record(status: "completed" | "cancelled", elapsedMs: number, startedAt: number) {
    if (saving.current) return;
    saving.current = true;
    setState({ mode: "idle" });
    const actual = Math.round(elapsedMs / 1000);
    if (actual >= 60) {
      const { error } = await supabase.from("focus_sessions").insert({
        planned_minutes: minutes,
        actual_seconds: actual,
        status,
        task_id: taskId === "none" ? null : taskId,
        label: tasks.find((t) => t.id === taskId)?.title ?? null,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date().toISOString(),
      });
      if (error) toast.error(error.message);
      else
        toast.success(status === "completed" ? "Focus session complete" : "Partial session saved");
      qc.invalidateQueries({ queryKey: ["focus"] });
    }
    saving.current = false;
  }

  useEffect(() => {
    if (state.mode === "running" && left === 0)
      record("completed", state.elapsedBefore + (state.endsAt - state.segStart), state.startedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, state.mode]);

  const start = () => {
    const t = Date.now();
    setNow(t);
    setState({
      mode: "running",
      endsAt: t + minutes * 60_000,
      startedAt: t,
      elapsedBefore: 0,
      segStart: t,
    });
  };
  const pause = () => {
    if (state.mode !== "running") return;
    const t = Date.now();
    setState({
      mode: "paused",
      remaining: remainingSeconds(state.endsAt, t),
      startedAt: state.startedAt,
      elapsed: state.elapsedBefore + (t - state.segStart),
    });
  };
  const resume = () => {
    if (state.mode !== "paused") return;
    const t = Date.now();
    setNow(t);
    setState({
      mode: "running",
      endsAt: t + state.remaining * 1000,
      startedAt: state.startedAt,
      elapsedBefore: state.elapsed,
      segStart: t,
    });
  };
  const stop = () => {
    if (state.mode === "running")
      record("cancelled", state.elapsedBefore + (Date.now() - state.segStart), state.startedAt);
    else if (state.mode === "paused") record("cancelled", state.elapsed, state.startedAt);
  };

  const total = minutes * 60;
  const pct = 1 - left / total;
  return (
    <section className="paper-card p-5" id="focus">
      <h2 className="text-2xl">Focus</h2>
      <div className="mt-4 flex flex-col items-center">
        <div className="relative size-40">
          <svg viewBox="0 0 100 100" className="size-full -rotate-90">
            <circle cx="50" cy="50" r="44" fill="none" strokeWidth="5" className="stroke-muted" />
            <circle
              cx="50"
              cy="50"
              r="44"
              fill="none"
              strokeWidth="5"
              strokeLinecap="round"
              className="stroke-primary transition-all"
              strokeDasharray={276.5}
              strokeDashoffset={276.5 * (1 - pct)}
            />
          </svg>
          <span
            className="absolute inset-0 flex items-center justify-center font-display text-4xl tabular-nums"
            aria-live="polite"
          >
            {fmt(left)}
          </span>
        </div>
        {state.mode === "idle" && (
          <div className="mt-4 flex w-full flex-wrap justify-center gap-1.5">
            {[5, 15, 25, 50].map((m) => (
              <button
                key={m}
                onClick={() => setMinutes(m)}
                className={`rounded-full border px-3 py-1 text-xs ${minutes === m ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {m} min
              </button>
            ))}
          </div>
        )}
        <Select value={taskId} onValueChange={setTaskId} disabled={state.mode !== "idle"}>
          <SelectTrigger className="mt-3 w-full" aria-label="Link to task">
            <SelectValue placeholder="Link a task" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No linked task</SelectItem>
            {tasks
              .filter((t) => !t.completed)
              .map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <div className="mt-4 flex gap-2">
          {state.mode === "idle" && (
            <Button onClick={start}>
              <Play />
              Start
            </Button>
          )}
          {state.mode === "running" && (
            <Button variant="secondary" onClick={pause}>
              <Pause />
              Pause
            </Button>
          )}
          {state.mode === "paused" && (
            <Button onClick={resume}>
              <RotateCcw />
              Resume
            </Button>
          )}
          {state.mode !== "idle" && (
            <Button variant="outline" onClick={stop}>
              <Square />
              Stop
            </Button>
          )}
        </div>
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Sessions over a minute are saved. Timing stays accurate in background tabs.
        </p>
      </div>
    </section>
  );
}
