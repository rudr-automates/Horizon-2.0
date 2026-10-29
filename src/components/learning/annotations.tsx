import { useState } from "react";
import { useSuspenseQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Pencil, Trash2, Plus, Check, X } from "lucide-react";
import { toast } from "sonner";
import { annotationsQuery } from "@/lib/learning-queries";
import { formatPosition } from "@/lib/learning";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function Annotations({
  lessonId,
  userId,
  position,
  onSeek,
  mode,
}: {
  lessonId: string;
  userId: string;
  position: number;
  onSeek: (n: number) => void;
  mode: "notes" | "bookmarks";
}) {
  const { data } = useSuspenseQuery(annotationsQuery(lessonId, userId));
  const qc = useQueryClient();
  const [body, setBody] = useState(""),
    [label, setLabel] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [edited, setEdited] = useState("");
  const action = useMutation({
    mutationFn: async (fn: () => PromiseLike<{ error: unknown }>) => {
      const { error } = await fn();
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["learning", "annotations", userId, lessonId] });
      setBody("");
      setLabel("");
      setEditing(null);
    },
    onError: (e) => toast.error(e.message),
  });
  const notes = mode === "notes";
  const items = notes ? data.notes : data.bookmarks;
  return (
    <div>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          action.mutate(() =>
            notes
              ? supabase.from("lesson_notes").insert({
                  user_id: userId,
                  lesson_id: lessonId,
                  body: body.trim(),
                  timestamp_seconds: position,
                })
              : supabase.from("lesson_bookmarks").insert({
                  user_id: userId,
                  lesson_id: lessonId,
                  label: label.trim() || "Saved moment",
                  timestamp_seconds: position,
                }),
          );
        }}
      >
        <Label htmlFor={notes ? "new-note" : "new-bookmark"}>
          {notes ? "New note" : "Bookmark label"} · {formatPosition(position)}
        </Label>
        {notes ? (
          <Textarea
            id="new-note"
            placeholder="Your thoughts on this moment…"
            value={body}
            maxLength={10000}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-28"
          />
        ) : (
          <Input
            id="new-bookmark"
            placeholder="Saved moment"
            value={label}
            maxLength={200}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}
        <Button disabled={action.isPending || (notes && !body.trim())}>
          <Plus />
          {notes ? "Save note" : "Save bookmark"}
        </Button>
      </form>
      <ul className="mt-5 divide-y">
        {items.map((item) => {
          const text = "body" in item ? item.body : item.label;
          const table = notes ? "lesson_notes" : "lesson_bookmarks";
          return (
            <li key={item.id} className="py-4">
              <div className="flex items-center justify-between">
                <Button
                  variant="link"
                  size="sm"
                  className="px-0"
                  onClick={() => onSeek(item.timestamp_seconds)}
                >
                  <Bookmark />
                  {formatPosition(item.timestamp_seconds)}
                </Button>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${notes ? "note" : "bookmark"}`}
                    title="Edit"
                    disabled={action.isPending}
                    onClick={() => {
                      setEditing(item.id);
                      setEdited(text);
                    }}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${notes ? "note" : "bookmark"}`}
                    title="Delete"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate(() =>
                        supabase.from(table).delete().eq("id", item.id).eq("user_id", userId),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {editing === item.id ? (
                <div className="space-y-2">
                  <Textarea
                    aria-label="Edit saved text"
                    maxLength={notes ? 10000 : 200}
                    value={edited}
                    onChange={(e) => setEdited(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!edited.trim() || action.isPending}
                      onClick={() =>
                        action.mutate(() =>
                          notes
                            ? supabase
                                .from("lesson_notes")
                                .update({ body: edited.trim() })
                                .eq("id", item.id)
                                .eq("user_id", userId)
                            : supabase
                                .from("lesson_bookmarks")
                                .update({ label: edited.trim() })
                                .eq("id", item.id)
                                .eq("user_id", userId),
                        )
                      }
                    >
                      <Check />
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      <X />
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
              )}
            </li>
          );
        })}
      </ul>
      {!items.length && (
        <p className="mt-7 text-center text-sm text-muted-foreground">
          {notes ? "No notes for this lesson yet." : "No saved moments yet."}
        </p>
      )}
    </div>
  );
}
