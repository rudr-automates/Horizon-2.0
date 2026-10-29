import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Code2,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  PlayCircle,
  Presentation,
  ScrollText,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ResourceKind } from "@/server/retrieval/types";

interface ResourceRow {
  id: string;
  kind: ResourceKind;
  title: string;
  status: "pending" | "processing" | "ready" | "failed";
  source_url: string | null;
  metadata: Record<string, unknown> | null;
  lesson_id: string | null;
  processing_error: string | null;
}

const KIND: Record<ResourceKind, { label: string; icon: typeof FileText }> = {
  pdf: { label: "PDF", icon: FileText },
  slides: { label: "Slides", icon: Presentation },
  markdown: { label: "Notes", icon: BookOpen },
  text: { label: "Text", icon: ScrollText },
  code: { label: "Code", icon: Code2 },
  video_transcript: { label: "Transcript", icon: PlayCircle },
};

const ACCEPT =
  ".pdf,.pptx,.txt,.md,.markdown,.vtt,.srt,.webvtt,.py,.ts,.tsx,.js,.jsx,.json,.csv,.css,.html,.java,.c,.cpp,.h,.rs,.go,.rb,.php,.sql,.sh,.yaml,.yml,.toml";

function detailOf(resource: ResourceRow): string {
  const kind = KIND[resource.kind]?.label ?? "Resource";
  const metadata = resource.metadata ?? {};
  const pages = metadata["pageCount"];
  const slides = metadata["slideCount"];
  const size = metadata["sizeBytes"];
  const parts = [kind];
  if (typeof pages === "number") parts.push(`${pages} pages`);
  else if (typeof slides === "number") parts.push(`${slides} slides`);
  if (typeof size === "number" && size > 0) {
    parts.push(`${Math.max(1, Math.round(size / 1_024))} KB`);
  }
  if (metadata["storage_path"]) parts.push("private");
  return parts.join(" · ");
}

export function LessonResources({
  lessonId,
  courseId,
}: {
  lessonId: string;
  courseId?: string | undefined;
}) {
  const [resources, setResources] = useState<ResourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const lessonQuery = supabase
      .from("learning_resources")
      .select("id,kind,title,status,source_url,metadata,lesson_id,processing_error")
      .eq("lesson_id", lessonId)
      .order("created_at", { ascending: true });
    const courseQuery = courseId
      ? supabase
          .from("learning_resources")
          .select("id,kind,title,status,source_url,metadata,lesson_id,processing_error")
          .eq("course_id", courseId)
          .is("lesson_id", null)
          .order("created_at", { ascending: true })
      : null;
    const [lessonResult, courseResult] = await Promise.all([
      lessonQuery,
      courseQuery ?? Promise.resolve({ data: [], error: null }),
    ]);
    if (lessonResult.error) {
      setError(
        lessonResult.error.code === "42P01"
          ? "Resource storage is not available yet. Apply the retrieval migration."
          : "Lesson resources could not be loaded.",
      );
      setLoading(false);
      return;
    }
    if (courseResult.error) {
      setError("Course resources could not be loaded.");
      setLoading(false);
      return;
    }
    const merged = new Map<string, ResourceRow>();
    for (const row of [...(lessonResult.data ?? []), ...(courseResult.data ?? [])]) {
      merged.set(row.id, row as ResourceRow);
    }
    setResources([...merged.values()]);
    setLoading(false);
  }, [lessonId, courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openResource(resource: ResourceRow) {
    let url = resource.source_url;
    const storagePath = resource.metadata?.["storage_path"];
    if (!url && typeof storagePath === "string") {
      const signed = await supabase.storage
        .from("learning-resources")
        .createSignedUrl(storagePath, 3_600);
      if (signed.error || !signed.data?.signedUrl) {
        toast.error("This private resource could not be opened.");
        return;
      }
      url = signed.data.signedUrl;
    }
    if (!url) {
      toast.error("This resource has no stored source file.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function upload(file: File) {
    if (uploading) return;
    setUploading(true);
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        toast.error("Your session expired. Sign in again to upload.");
        return;
      }
      const form = new FormData();
      form.set("file", file);
      form.set("lessonId", lessonId);
      const response = await fetch("/api/resources/upload", {
        method: "POST",
        headers: { authorization: `Bearer ${data.session.access_token}` },
        body: form,
      });
      const payload = (await response.json().catch(() => null)) as {
        status?: string;
        message?: string;
        embeddingStatus?: string;
        chunkCount?: number;
      } | null;
      if (!response.ok || payload?.status !== "ready") {
        toast.error(payload?.message ?? "The resource could not be indexed.");
        return;
      }
      const semantic =
        payload.embeddingStatus === "complete"
          ? "semantic and keyword search"
          : "keyword search only (embeddings unavailable)";
      toast.success(`Indexed ${payload.chunkCount ?? 0} passages for ${semantic}.`);
      await load();
    } catch {
      toast.error("The upload could not be completed. No content was indexed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-lg border bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              <Upload className="size-4 text-forest" />
              Add lesson material
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              PDF, PPTX, Markdown, text, code or SRT/WebVTT captions. Text is extracted, chunked and
              embedded; scans need OCR first.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? "Indexing…" : "Choose file"}
          </Button>
        </div>
        <Input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          aria-label="Upload lesson material"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </div>

      {error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          {error}
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading lesson resources…
        </p>
      ) : resources.length ? (
        <ul className="divide-y">
          {resources.map((resource) => {
            const kind = KIND[resource.kind] ?? KIND.text;
            const Icon = kind.icon;
            const openable = Boolean(resource.source_url || resource.metadata?.["storage_path"]);
            return (
              <li key={resource.id} className="flex items-center gap-3 py-4">
                <Icon className="size-5 shrink-0 text-forest" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{resource.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {detailOf(resource)}
                    {resource.status !== "ready" ? ` · ${resource.status}` : ""}
                  </p>
                  {resource.processing_error && (
                    <p className="mt-1 text-xs text-destructive">{resource.processing_error}</p>
                  )}
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={!openable || resource.status !== "ready"}
                  title={`Open ${resource.title}`}
                  aria-label={`Open ${resource.title}`}
                  onClick={() => void openResource(resource)}
                >
                  {resource.source_url?.startsWith("http") ? <ExternalLink /> : <Download />}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No material attached to this lesson yet. Upload a PDF, slide deck or notes to ground the
          tutor in your own sources.
        </p>
      )}
    </div>
  );
}
