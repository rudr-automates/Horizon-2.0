import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Link as LinkIcon, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { parseVideoUrl } from "@/lib/learning";

/** Mirrors MAX_VIDEO_BYTES on the upload route; the server re-checks both. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

type Mode = "link" | "file";

export function ImportVideo({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<Mode>("link");
  const [url, setUrl] = useState(""),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const navigate = useNavigate(),
    qc = useQueryClient();

  async function openLesson(lessonId: string) {
    await qc.invalidateQueries({ queryKey: ["learning", "catalog"] });
    setOpen(false);
    setUrl("");
    setTitle("");
    setFile(null);
    navigate({ to: "/learn/$lessonId", params: { lessonId } });
  }

  async function submitLink(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    try {
      const parsed = parseVideoUrl(url);
      setBusy(true);
      const { data, error } = await supabase
        .from("lessons")
        .insert({
          user_id: userId,
          title: title.trim(),
          video_url: parsed.url,
          provider: parsed.provider,
        })
        .select("id")
        .single();
      if (error) throw error;
      await openLesson(data.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add this video.");
    } finally {
      setBusy(false);
    }
  }

  async function submitFile(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!file) return;
    if (file.size > MAX_VIDEO_BYTES) {
      toast.error("Videos must be 200 MB or smaller.");
      return;
    }
    setBusy(true);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        toast.error("Your session expired. Sign in again to upload.");
        setBusy(false);
        return;
      }
      const form = new FormData();
      form.set("file", file);
      form.set("title", title.trim());
      const response = await fetch("/api/videos/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${data.session.access_token}` },
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        lessonId?: string;
        message?: string;
      } | null;
      if (!response.ok || payload?.status !== "ready" || !payload.lessonId) {
        toast.error(payload?.message ?? "The video could not be added.");
        return;
      }
      await openLesson(payload.lessonId);
    } catch {
      toast.error("The video could not be uploaded. Nothing was added.");
    } finally {
      setBusy(false);
    }
  }

  const pick = (next: Mode) => {
    setMode(next);
    setFile(null);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus />
          Import video
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a video to your library</DialogTitle>
          <DialogDescription>
            Paste a YouTube, Vimeo or public MP4/WebM link, or upload an MP4/WebM file from this
            computer. Uploaded files stay in private storage only you can read. Playback depends on
            the source's embedding permissions. Captions are added inside the lesson.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2" role="tablist" aria-label="Import method">
          <Button
            type="button"
            size="sm"
            variant={mode === "link" ? "default" : "outline"}
            role="tab"
            aria-selected={mode === "link"}
            onClick={() => pick("link")}
          >
            <LinkIcon />
            Paste a link
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "file" ? "default" : "outline"}
            role="tab"
            aria-selected={mode === "file"}
            onClick={() => pick("file")}
          >
            <Upload />
            Upload a file
          </Button>
        </div>
        <form onSubmit={mode === "link" ? submitLink : submitFile} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="video-title">Lesson title</Label>
            <Input
              id="video-title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {mode === "link" ? (
            <div className="space-y-2">
              <Label htmlFor="video-url">Video URL</Label>
              <Input
                id="video-url"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="video-file">Video file (MP4 or WebM, up to 200 MB)</Label>
              <Input
                id="video-file"
                type="file"
                accept=".mp4,.webm,video/mp4,video/webm"
                required
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                {file
                  ? `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`
                  : "No file chosen."}
              </p>
            </div>
          )}
          <Button disabled={busy || !title.trim() || (mode === "file" && !file)} className="w-full">
            {mode === "link" ? <LinkIcon /> : <Upload />}
            {busy ? "Adding…" : mode === "link" ? "Add to library" : "Upload video"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
