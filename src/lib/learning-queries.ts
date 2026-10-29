import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type Lesson = Tables<"lessons">;
export const catalogQuery = queryOptions({
  queryKey: ["learning", "catalog"],
  queryFn: async () => {
    const [courses, lessons] = await Promise.all([
      supabase.from("courses").select("*").order("created_at"),
      supabase.from("lessons").select("*").order("position"),
    ]);
    if (courses.error) throw courses.error;
    if (lessons.error) throw lessons.error;
    return { courses: courses.data, lessons: lessons.data };
  },
});
export const progressQuery = (userId: string) =>
  queryOptions({
    queryKey: ["learning", "progress", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("lesson_progress")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
export const lessonQuery = (id: string) =>
  queryOptions({
    queryKey: ["learning", "lesson", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("lessons").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("This lesson is unavailable or you do not have access.");
      return data;
    },
  });
export const annotationsQuery = (id: string, userId: string) =>
  queryOptions({
    queryKey: ["learning", "annotations", userId, id],
    queryFn: async () => {
      const [notes, bookmarks] = await Promise.all([
        supabase
          .from("lesson_notes")
          .select("*")
          .eq("user_id", userId)
          .eq("lesson_id", id)
          .order("timestamp_seconds"),
        supabase
          .from("lesson_bookmarks")
          .select("*")
          .eq("user_id", userId)
          .eq("lesson_id", id)
          .order("timestamp_seconds"),
      ]);
      if (notes.error) throw notes.error;
      if (bookmarks.error) throw bookmarks.error;
      return { notes: notes.data, bookmarks: bookmarks.data };
    },
  });
