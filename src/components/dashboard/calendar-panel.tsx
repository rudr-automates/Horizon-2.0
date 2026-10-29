import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const eventsQuery = {
  queryKey: ["events"],
  queryFn: async () => {
    const { data, error } = await supabase.from("events").select("*").order("starts_at");
    if (error) throw error;
    return data;
  },
};

export function CalendarPanel() {
  const qc = useQueryClient();
  const { data: events = [] } = useQuery(eventsQuery);
  const [view, setView] = useState<"month" | "week">("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => localKey(new Date()));
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["events"] });

  const days = useMemo(() => {
    if (view === "week") {
      const s = new Date(cursor);
      s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(s);
        d.setDate(s.getDate() + i);
        return d;
      });
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = new Date(first);
    s.setDate(1 - ((first.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(s);
      d.setDate(s.getDate() + i);
      return d;
    });
  }, [cursor, view]);

  const byDay = useMemo(() => {
    const m: Record<string, typeof events> = {};
    for (const e of events) (m[localKey(new Date(e.starts_at))] ??= []).push(e);
    return m;
  }, [events]);

  const move = (dir: number) => {
    const d = new Date(cursor);
    if (view === "month") d.setMonth(d.getMonth() + dir);
    else d.setDate(d.getDate() + dir * 7);
    setCursor(d);
  };

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const start = new Date(`${selected}T${f.get("start")}`);
    const end = new Date(`${selected}T${f.get("end")}`);
    if (end <= start) {
      toast.error("End time must be after start.");
      return;
    }
    const { error } = await supabase.from("events").insert({
      title: String(f.get("title")),
      description: String(f.get("description") || "") || null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setOpen(false);
    refresh();
  }

  const dayEvents = byDay[selected] ?? [];
  const today = localKey(new Date());
  return (
    <section className="paper-card p-5" id="calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-2xl">
          {cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h2>
        <div className="flex items-center gap-1">
          <div className="mr-2 flex rounded-full border p-0.5 text-xs">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded-full px-2.5 py-1 capitalize",
                  view === v && "bg-forest text-forest-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>
          <Button size="icon" variant="ghost" onClick={() => move(-1)} aria-label="Previous">
            <ChevronLeft />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCursor(new Date());
              setSelected(today);
            }}
          >
            Today
          </Button>
          <Button size="icon" variant="ghost" onClick={() => move(1)} aria-label="Next">
            <ChevronRight />
          </Button>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {days.map((d) => {
          const k = localKey(d);
          const n = byDay[k]?.length ?? 0;
          return (
            <button
              key={k}
              onClick={() => setSelected(k)}
              className={cn(
                "flex flex-col items-center rounded-md py-2 text-sm",
                view === "week" && "py-4",
                d.getMonth() !== cursor.getMonth() &&
                  view === "month" &&
                  "text-muted-foreground/50",
                k === selected ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                k === today && k !== selected && "ring-1 ring-primary",
              )}
            >
              {d.getDate()}
              <span className="mt-0.5 flex h-1.5 gap-0.5">
                {Array.from({ length: Math.min(n, 3) }).map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      "size-1.5 rounded-full",
                      k === selected ? "bg-primary-foreground" : "bg-forest",
                    )}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-5 border-t pt-4">
        <div className="flex items-center justify-between">
          <p className="font-display text-lg">
            {new Date(`${selected}T12:00`).toLocaleDateString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
            })}
          </p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Plus />
                Plan session
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="font-display">New study session · {selected}</DialogTitle>
              </DialogHeader>
              <form onSubmit={create} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ev-title">Title</Label>
                  <Input id="ev-title" name="title" required />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="ev-s">Start</Label>
                    <Input id="ev-s" name="start" type="time" defaultValue="18:00" required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ev-e">End</Label>
                    <Input id="ev-e" name="end" type="time" defaultValue="19:00" required />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ev-d">Notes</Label>
                  <Input id="ev-d" name="description" />
                </div>
                <Button className="w-full">Save</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
        <ul className="mt-3 space-y-2">
          {dayEvents.length === 0 && (
            <li className="text-sm text-muted-foreground">Nothing planned.</li>
          )}
          {dayEvents.map((e) => (
            <li key={e.id} className="flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2">
              <span className="w-24 text-xs tabular-nums text-muted-foreground">
                {new Date(e.starts_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                –
                {new Date(e.ends_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              <span
                className={cn(
                  "flex-1 text-sm",
                  e.completed && "line-through text-muted-foreground",
                )}
              >
                {e.title}
              </span>
              <button
                onClick={async () => {
                  await supabase.from("events").update({ completed: !e.completed }).eq("id", e.id);
                  refresh();
                }}
                aria-label="Toggle complete"
                className="text-forest"
              >
                <Check className="size-4" />
              </button>
              <button
                onClick={async () => {
                  await supabase.from("events").delete().eq("id", e.id);
                  refresh();
                }}
                aria-label="Delete event"
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
