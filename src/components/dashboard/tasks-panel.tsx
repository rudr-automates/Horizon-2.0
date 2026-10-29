import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const tasksQuery = {
  queryKey: ["tasks"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("tasks")
      .select("*")
      .order("completed")
      .order("due_date", { nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  },
};

export function TasksPanel() {
  const qc = useQueryClient();
  const { data: tasks = [] } = useQuery(tasksQuery);
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("medium");
  const [tag, setTag] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["tasks"] });

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("tasks")
        .insert({ title, due_date: due || null, priority, tag: tag || null });
      if (error) throw error;
    },
    onSuccess: () => {
      setTitle("");
      setDue("");
      setTag("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const shown = tasks.filter(
    (t) => filter === "all" || (filter === "done" ? t.completed : !t.completed),
  );
  return (
    <section className="paper-card p-5" id="tasks">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl">Tasks</h2>
        <div className="flex gap-1 text-xs">
          {(["open", "done", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full px-2.5 py-1 capitalize",
                filter === f ? "bg-forest text-forest-foreground" : "hover:bg-muted",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) add.mutate();
        }}
        className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-[1fr_auto_auto_auto_auto]"
      >
        <Input
          className="col-span-2 sm:col-span-1"
          placeholder="New task…"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Task title"
        />
        <Input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          aria-label="Due date"
        />
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="sm:w-24"
          aria-label="Tag"
        />
        <Button disabled={add.isPending} aria-label="Add task">
          <Plus />
        </Button>
      </form>
      <ul className="mt-4 divide-y">
        {shown.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground">
            {filter === "open"
              ? "Nothing outstanding. Add your first task above."
              : "No tasks here."}
          </li>
        )}
        {shown.map((t) => (
          <li key={t.id} className="flex items-center gap-3 py-2.5">
            <Checkbox
              checked={t.completed}
              onCheckedChange={async (v) => {
                await supabase.from("tasks").update({ completed: !!v }).eq("id", t.id);
                refresh();
              }}
              aria-label={`Complete ${t.title}`}
            />
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "truncate text-sm",
                  t.completed && "text-muted-foreground line-through",
                )}
              >
                {t.title}
              </p>
              <p className="text-xs text-muted-foreground">
                {t.due_date ? `Due ${t.due_date}` : "No due date"}
                {t.tag ? ` · #${t.tag}` : ""}
              </p>
            </div>
            <Badge variant={t.priority === "high" ? "default" : "secondary"} className="capitalize">
              {t.priority}
            </Badge>
            <button
              onClick={async () => {
                await supabase.from("tasks").delete().eq("id", t.id);
                refresh();
              }}
              aria-label={`Delete ${t.title}`}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
