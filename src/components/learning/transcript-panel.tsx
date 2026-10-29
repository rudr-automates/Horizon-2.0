import { useEffect, useRef, useState } from "react";
import { Search, Captions } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { Lesson } from "@/lib/learning-queries";
import { activeSegment, formatPosition, parseCaptions, transcriptSegments } from "@/lib/learning";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function TranscriptPanel({
  lesson,
  position,
  onSeek,
}: {
  lesson: Lesson;
  position: number;
  onSeek: (n: number) => void;
}) {
  const [search, setSearch] = useState(""),
    [captionText, setCaptionText] = useState(""),
    [busy, setBusy] = useState(false),
    [follow, setFollow] = useState(true);
  const segments = transcriptSegments(lesson.transcript);
  const current = activeSegment(segments, position);
  const qc = useQueryClient();
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!follow || search) return;
    const el = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (el && list.current)
      list.current.scrollTo({
        top: el.offsetTop - list.current.offsetTop - 20,
        behavior: "smooth",
      });
  }, [current, follow, search]);
  async function save() {
    try {
      const parsed = parseCaptions(captionText);
      setBusy(true);
      const { error } = await supabase
        .from("lessons")
        .update({ transcript: parsed, transcript_status: "available" })
        .eq("id", lesson.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["learning", "lesson", lesson.id] });
      await qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
      toast.success("Captions saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save captions");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="relative">
        <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          aria-label="Search transcript"
          placeholder="Search the transcript"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {segments.length} passages · {lesson.transcript_status}
        </span>
        <Button
          variant={follow ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setFollow(!follow)}
          aria-pressed={follow}
        >
          Follow playback
        </Button>
      </div>
      <div ref={list} className="relative mt-3 max-h-[480px] space-y-1 overflow-y-auto pr-1">
        {segments
          .map((s, i) => ({ s, i }))
          .filter(({ s }) =>
            `${s.heading || ""} ${s.text}`.toLowerCase().includes(search.toLowerCase()),
          )
          .map(({ s, i }) => (
            <Button
              key={s.start}
              variant="ghost"
              aria-current={current === i ? "true" : undefined}
              className={cn(
                "h-auto w-full items-start justify-start gap-3 whitespace-normal px-3 py-4 text-left",
                current === i && "border-l-2 border-primary bg-accent",
              )}
              onClick={() => onSeek(s.start)}
            >
              <span className="mt-0.5 shrink-0 font-mono text-xs text-primary">
                {formatPosition(s.start)}
              </span>
              <span className="min-w-0">
                <span className="mb-1 block text-sm font-semibold">{s.heading || "Passage"}</span>
                <span className="block text-sm font-normal leading-6">{s.text}</span>
              </span>
            </Button>
          ))}
      </div>
      {search &&
        !segments.some((s) =>
          `${s.heading || ""} ${s.text}`.toLowerCase().includes(search.toLowerCase()),
        ) && (
          <p className="py-6 text-center text-sm text-muted-foreground">No matching passages.</p>
        )}
      {!segments.length && (
        <p className="py-6 text-sm text-muted-foreground">
          No captions have been added. Video playback does not automatically provide a transcript.
        </p>
      )}
      {!lesson.is_demo && (
        <details className="mt-5 border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">Add or replace captions</summary>
          <div className="mt-4 space-y-3">
            <Label htmlFor="caption-file">SRT or WebVTT file</Label>
            <Input
              id="caption-file"
              type="file"
              accept=".srt,.vtt"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 1024 * 1024) {
                  toast.error("Caption files must be under 1 MB.");
                  return;
                }
                setCaptionText(await file.text());
              }}
            />
            <Textarea
              aria-label="Timestamped captions"
              placeholder="Paste timestamped SRT or WebVTT captions"
              value={captionText}
              onChange={(e) => setCaptionText(e.target.value)}
              maxLength={1000000}
            />
            <Button disabled={busy || !captionText.trim()} onClick={save}>
              <Captions />
              {busy ? "Saving…" : "Save captions"}
            </Button>
          </div>
        </details>
      )}
    </div>
  );
}
