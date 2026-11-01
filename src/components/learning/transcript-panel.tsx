import { useEffect, useRef, useState } from "react";
import { Search, Captions, RotateCcw, Loader2, Sparkles, AlertTriangle } from "lucide-react";
import type { IngestionStatus } from "@/lib/ingestion-types";
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
  ingestion,
  ingestionError,
  ingestionBusy,
  onRetryIngestion,
}: {
  lesson: Lesson;
  position: number;
  onSeek: (n: number) => void;
  ingestion?: IngestionStatus | null;
  ingestionError?: string | null;
  ingestionBusy?: boolean;
  onRetryIngestion?: () => void;
}) {
  const processing = ingestion?.state === "queued" || ingestion?.state === "processing";
  const blocked = ingestion?.state === "needs_captions" || ingestion?.state === "failed";
  const [search, setSearch] = useState(""),
    [captionText, setCaptionText] = useState(""),
    [busy, setBusy] = useState(false),
    [follow, setFollow] = useState(true),
    [job, setJob] = useState<{
      id: string;
      status: string;
      progress?: { stage?: string };
      error_message?: string | null;
    } | null>(null),
    [jobBusy, setJobBusy] = useState(false),
    [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const segments = transcriptSegments(lesson.transcript);
  const current = activeSegment(segments, position);
  const qc = useQueryClient();
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (lesson.is_demo) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let activeJob = false;
      try {
        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          if (alive) timer = setTimeout(poll, 30_000);
          return;
        }
        const health = await fetch("/api/whisper/worker/heartbeat", {
          headers: { authorization: `Bearer ${data.session.access_token}` },
        });
        const healthPayload = (await health.json().catch(() => null)) as {
          online?: boolean;
        } | null;
        if (alive) setWorkerOnline(health.ok ? Boolean(healthPayload?.online) : null);
        const response = await fetch(
          `/api/whisper/jobs?lessonId=${encodeURIComponent(lesson.id)}`,
          {
            headers: { authorization: `Bearer ${data.session.access_token}` },
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          job?: {
            id: string;
            status: string;
            progress?: { stage?: string };
            error_message?: string | null;
          } | null;
        } | null;
        if (alive && response.ok) {
          setJob(payload?.job ?? null);
          activeJob = Boolean(payload?.job && !["ready", "failed"].includes(payload.job.status));
          if (payload?.job?.status === "ready") {
            await qc.invalidateQueries({ queryKey: ["learning", "lesson", lesson.id] });
            await qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
          }
        }
        if (alive) timer = setTimeout(poll, activeJob ? 8000 : 30_000);
      } catch {
        /* Transient status errors do not interrupt captions or playback. */
        if (alive) timer = setTimeout(poll, 30_000);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [lesson.id, lesson.is_demo, job?.id, job?.status, qc]);
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
  async function requestWhisper() {
    try {
      setJobBusy(true);
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Sign in again to request transcription.");
      const response = await fetch("/api/whisper/jobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${data.session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ lessonId: lesson.id }),
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        message?: string;
        job?: { id: string; status: string };
      } | null;
      if (!response.ok)
        throw new Error(payload?.message ?? "Transcription could not be requested.");
      setJob(payload?.job ?? { id: "", status: payload?.status ?? "queued" });
      toast.success("Transcription job queued");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not request transcription");
    } finally {
      setJobBusy(false);
    }
  }
  return (
    <div>
      {!lesson.is_demo && (processing || blocked || ingestion?.state === "none") && (
        <div
          className="mb-3 rounded-md border bg-muted/40 p-3 text-sm"
          aria-live="polite"
          role="status"
        >
          <p className="flex items-center gap-2 font-medium">
            {processing ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : blocked ? (
              <AlertTriangle className="size-4 shrink-0 text-amber-700" />
            ) : (
              <Sparkles className="size-4 shrink-0 text-primary" />
            )}
            {ingestion?.stage ?? "Automatic processing"}
            {processing && ingestion?.percent !== undefined && (
              <span className="text-xs text-muted-foreground">{ingestion.percent}%</span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{ingestion?.message}</p>
          {processing && ingestion?.percent !== undefined && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${ingestion.percent}%` }}
              />
            </div>
          )}
          {blocked && onRetryIngestion && ingestion?.canRetry && (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              disabled={Boolean(ingestionBusy)}
              onClick={onRetryIngestion}
            >
              <RotateCcw />
              {ingestionBusy ? "Retrying…" : "Retry processing"}
            </Button>
          )}
          {ingestionError && (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {ingestionError}
            </p>
          )}
        </div>
      )}
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
      {!lesson.is_demo &&
        lesson.video_url.startsWith("storage://lesson-videos/") &&
        (job !== null || workerOnline === true) && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <div>
              <p className="font-medium">Local Whisper transcription (optional)</p>
              <p className="text-xs text-muted-foreground">
                {job
                  ? `${job.status === "retry_wait" ? "Waiting to retry" : job.status}${job.progress?.stage ? ` · ${job.progress.stage}` : ""}${job.error_message ? ` · ${job.error_message}` : ""}${workerOnline === false ? " · PC worker offline; queued work waits for reconnect." : ""}`
                  : workerOnline === false
                    ? "PC worker offline; queued jobs wait until it reconnects."
                    : workerOnline
                      ? "PC worker online. Queue this private upload for transcription."
                      : "Checking your PC worker status…"}
              </p>
            </div>
            {(!job || job.status === "failed") && (
              <Button size="sm" variant="outline" disabled={jobBusy} onClick={requestWhisper}>
                <RotateCcw />
                {jobBusy ? "Queueing…" : job ? "Retry" : "Transcribe"}
              </Button>
            )}
          </div>
        )}
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
          {processing
            ? "The transcript is being generated. This panel updates automatically when it is ready."
            : blocked
              ? "No transcript is available yet. Use the processing panel above, upload timestamped captions below, or upload the video file itself."
              : "No captions have been added yet."}
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
