export type TranscriptSegment = { start: number; end: number; text: string; heading?: string };

export function transcriptSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (s): s is TranscriptSegment =>
      typeof s === "object" &&
      s !== null &&
      typeof s.start === "number" &&
      typeof s.end === "number" &&
      s.start >= 0 &&
      s.end > s.start &&
      typeof s.text === "string",
  );
}

export function formatPosition(seconds: number) {
  const n = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

export function clampPosition(position: number, duration: number) {
  return Math.min(Math.max(0, Number.isFinite(position) ? position : 0), Math.max(0, duration));
}

export function activeSegment(segments: TranscriptSegment[], position: number) {
  return segments.findIndex((s) => position >= s.start && position < s.end);
}

export function courseCompletion(
  lessonIds: string[],
  progress: { lesson_id: string; completed: boolean }[],
) {
  if (!lessonIds.length) return 0;
  const complete = new Set(progress.filter((p) => p.completed).map((p) => p.lesson_id));
  return Math.round((lessonIds.filter((id) => complete.has(id)).length / lessonIds.length) * 100);
}

// Count elapsed real playing time, never jumps on the seek bar or buffer gaps.
export function watchedDelta(
  previous: number,
  position: number,
  elapsed: number,
  playing: boolean,
  seeking: boolean,
  rate = 1,
) {
  if (!playing || seeking || elapsed <= 0 || elapsed > 3 || position <= previous) return 0;
  const advance = position - previous;
  if (advance > elapsed * rate + 0.75) return 0;
  return Math.min(elapsed, advance / rate);
}

export function parseVideoUrl(raw: string): {
  url: string;
  provider: "youtube" | "vimeo" | "direct";
} {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter a valid HTTPS video URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Use a public HTTPS video URL.");
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const id =
      host === "youtu.be"
        ? url.pathname.slice(1)
        : url.searchParams.get("v") || url.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)?.[1];
    if (!id || !/^[\w-]{11}$/.test(id))
      throw new Error("This YouTube link does not identify a video.");
    return { provider: "youtube", url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (host === "vimeo.com" || host === "www.vimeo.com" || host === "player.vimeo.com") {
    const id = url.pathname.match(/\/(?:video\/)?(\d+)$/)?.[1];
    if (!id) throw new Error("Use a Vimeo video link.");
    return { provider: "vimeo", url: `https://vimeo.com/${id}${url.search}` };
  }
  if (
    host === "localhost" ||
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host)
  )
    throw new Error("Use a public video host, not a local address.");
  if (!/\.(mp4|webm)$/i.test(url.pathname))
    throw new Error("Supported links: YouTube, Vimeo, or direct MP4/WebM videos.");
  return { provider: "direct", url: url.href };
}

export function parseCaptions(input: string): TranscriptSegment[] {
  const blocks = input
    .replace(/\r/g, "")
    .trim()
    .replace(/^WEBVTT[^\n]*\n/, "")
    .split(/\n\s*\n/);
  const result: TranscriptSegment[] = [];
  const stamp = (s: string) => {
    const parts = s.replace(",", ".").split(":").map(Number);
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // WebVTT allows NOTE/STYLE/REGION blocks alongside cues. They carry no
    // timing, so they are skipped rather than treated as a malformed cue.
    if (/^(?:NOTE|STYLE|REGION)\b/i.test(trimmed)) continue;
    const lines = trimmed.split("\n");
    const index = lines.findIndex((l) => l.includes("-->"));
    if (index < 0) throw new Error("Use timestamped SRT or WebVTT captions.");
    const match = lines[index]?.match(
      /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})(?:\s+.*)?$/,
    );
    if (!match?.[1] || !match[2]) throw new Error("A caption timestamp is invalid.");
    const start = stamp(match[1]),
      end = stamp(match[2]);
    const text = lines
      .slice(index + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .trim();
    if (
      !text ||
      !Number.isFinite(start) ||
      end <= start ||
      (result.length && start < (result.at(-1)?.end ?? 0))
    )
      throw new Error("Captions need text and ordered, non-overlapping time ranges.");
    result.push({ start, end, text });
  }
  if (!result.length) throw new Error("No timestamped captions found.");
  return result;
}
