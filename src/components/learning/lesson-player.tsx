import ReactPlayer from "react-player";
import { useEffect, useRef, useState } from "react";
import type { Lesson } from "@/lib/learning-queries";
import { clampPosition, watchedDelta } from "@/lib/learning";
import { isStoredVideoUrl, resolveVideoUrl } from "@/lib/video-url";

/**
 * Some catalogue lessons were seeded with videos hosted by the previous preview
 * environment. Those files no longer exist anywhere, so the player states that
 * plainly instead of showing a control that can never play. Transcripts, slide
 * citations and tutoring for these lessons are unaffected.
 */
const RETIRED_PREVIEW_MEDIA = "/__l5e/";

export function LessonPlayer({
  lesson,
  initialPosition,
  seek,
  onPosition,
  onCheckpoint,
  onDuration,
}: {
  lesson: Lesson;
  initialPosition: number;
  seek: { time: number; key: number } | null;
  onPosition: (time: number, watched: number) => void;
  onCheckpoint: () => void;
  onDuration: (duration: number) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const previous = useRef({ position: initialPosition, wall: performance.now() });
  const ready = useRef(false),
    playing = useRef(false),
    seeking = useRef(false);
  const [failed, setFailed] = useState(false);
  // Private uploads store a storage:// reference; it is signed for this session only.
  const stored = isStoredVideoUrl(lesson.video_url);
  const [src, setSrc] = useState<string | null>(() => (stored ? null : lesson.video_url));
  useEffect(() => {
    let cancelled = false;
    if (!isStoredVideoUrl(lesson.video_url)) {
      setSrc(lesson.video_url);
      setFailed(false);
      return;
    }
    setSrc(null);
    setFailed(false);
    resolveVideoUrl(lesson.video_url)
      .then((signed) => {
        if (!cancelled) setSrc(signed);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lesson.video_url]);
  useEffect(() => {
    if (seek && ref.current)
      ref.current.currentTime = clampPosition(
        seek.time,
        ref.current.duration || lesson.duration_seconds,
      );
  }, [seek, lesson.duration_seconds]);
  function load() {
    const p = ref.current;
    if (!p) return;
    if (Number.isFinite(p.duration)) onDuration(p.duration);
    if (!ready.current) {
      p.currentTime = clampPosition(initialPosition, p.duration || lesson.duration_seconds);
      ready.current = true;
    }
  }
  function update() {
    const p = ref.current;
    if (!p) return;
    const now = performance.now();
    const delta = watchedDelta(
      previous.current.position,
      p.currentTime,
      (now - previous.current.wall) / 1000,
      playing.current,
      seeking.current,
      p.playbackRate || 1,
    );
    previous.current = { position: p.currentTime, wall: now };
    onPosition(p.currentTime, delta);
  }
  if (lesson.video_url.startsWith(RETIRED_PREVIEW_MEDIA))
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-foreground text-background">
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-foreground p-6 text-center text-sm">
          <p className="font-medium">This demonstration video is no longer available.</p>
          <p className="max-w-md text-background/80">
            It was stored by the previous preview host and the file cannot be recovered. The
            transcript and citations for this lesson still work, and you can upload your own MP4 or
            WebM from Import video.
          </p>
        </div>
      </div>
    );
  if (failed)
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-foreground text-background">
        <div className="absolute inset-0 flex items-center justify-center bg-foreground p-6 text-center text-sm">
          This video could not play. The source may be unavailable, embedding may be restricted, or
          your access to the stored file may have expired.
        </div>
      </div>
    );
  if (stored && !src)
    return (
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-foreground text-background">
        <div className="absolute inset-0 flex items-center justify-center bg-foreground p-6 text-center text-sm">
          Loading video…
        </div>
      </div>
    );
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-foreground text-background">
      <ReactPlayer
        ref={ref}
        src={src ?? ""}
        controls
        playsInline
        width="100%"
        height="100%"
        onLoadedMetadata={load}
        onDurationChange={load}
        onTimeUpdate={update}
        onPlay={() => {
          playing.current = true;
          previous.current.wall = performance.now();
        }}
        onPause={() => {
          playing.current = false;
          onCheckpoint();
        }}
        onSeeking={() => {
          seeking.current = true;
        }}
        onSeeked={() => {
          seeking.current = false;
          previous.current = { position: ref.current?.currentTime || 0, wall: performance.now() };
          onPosition(previous.current.position, 0);
          onCheckpoint();
        }}
        onEnded={() => {
          playing.current = false;
          onCheckpoint();
        }}
        onError={() => setFailed(true)}
      />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-foreground p-6 text-center text-sm">
          This video could not play. The source may be unavailable or embedding may be restricted.
        </div>
      )}
    </div>
  );
}
