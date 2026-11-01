import { describe, expect, it } from "vitest";
import {
  buildTranscriptCues,
  buildTranscriptVtt,
  parseTranscriptSegments,
} from "@/server/ai/transcription/gemini.server";
import {
  parseYoutubeCaptionEvents,
  videoSourceKind,
} from "@/server/ingestion/video-pipeline.server";
import { isIngestionActive, isIngestionReady } from "@/lib/ingestion-types";
import { parseCaptions } from "@/lib/learning";

describe("video source resolution", () => {
  it("recognises private uploads, supported links and rejects unsafe schemes", () => {
    expect(videoSourceKind("storage://lesson-videos/abc/def.mp4")).toBe("upload");
    expect(videoSourceKind("https://youtu.be/LqFc0z-pQTg")).toBe("youtube");
    expect(videoSourceKind("https://www.youtube.com/watch?v=LqFc0z-pQTg")).toBe("youtube");
    expect(videoSourceKind("https://vimeo.com/123456789")).toBe("vimeo");
    expect(videoSourceKind("https://cdn.example.com/lesson.mp4")).toBe("direct");
    expect(videoSourceKind("https://cdn.example.com/lesson.webm?token=1")).toBe("direct");
    expect(videoSourceKind("http://cdn.example.com/lesson.mp4")).toBeNull();
    expect(videoSourceKind("storage://learning-resources/abc/lesson.mp4")).toBeNull();
    expect(videoSourceKind("https://example.com/page")).toBeNull();
    expect(videoSourceKind("not a url")).toBeNull();
  });
});

describe("provider transcript parsing", () => {
  it("keeps usable rows, sorts them and removes overlap and empty text", () => {
    const segments = parseTranscriptSegments({
      segments: [
        { start: 12.5, end: 20, text: "  Sparse attention reduces   computation.  " },
        { start: 2, end: 8, text: "<b>A sparse matrix</b> stores non-zero values." },
        { start: 18, end: 26, text: "This overlaps the previous passage." },
        { start: 30, end: 30, text: "zero length" },
        { start: -1, end: 4, text: "negative start" },
        { start: 40, end: 44, text: "   " },
        "not an object",
      ],
    });

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      start: 2,
      end: 8,
      text: "A sparse matrix stores non-zero values.",
    });
    expect(segments[1]).toEqual({
      start: 12.5,
      end: 20,
      text: "Sparse attention reduces computation.",
    });
  });

  it("returns nothing rather than inventing text for an unusable payload", () => {
    expect(parseTranscriptSegments(null)).toEqual([]);
    expect(parseTranscriptSegments({ segments: [{ start: 0, end: 1 }] })).toEqual([]);
    expect(parseTranscriptSegments([{ start: 3, end: 2, text: "backwards" }])).toEqual([]);
  });

  it("parses a YouTube json3 caption payload with timestamps", () => {
    const body = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 3200, segs: [{ utf8: "Welcome to the lecture." }] },
        {
          tStartMs: 3200,
          dDurationMs: 2400,
          segs: [{ utf8: "Today we" }, { utf8: " cover attention." }],
        },
        { tStartMs: 5600, segs: [] },
      ],
    });
    expect(parseYoutubeCaptionEvents(body)).toEqual([
      { start: 0, end: 3.2, text: "Welcome to the lecture." },
      { start: 3.2, end: 5.6, text: "Today we cover attention." },
    ]);
    expect(parseYoutubeCaptionEvents("not json")).toEqual([]);
  });
});

describe("caption cue building", () => {
  const segment = (start: number, end: number, text: string) => ({ start, end, text });

  it("merges contiguous provider segments into cue-sized passages", () => {
    const cues = buildTranscriptCues(
      [
        segment(0, 10, "A sparse matrix stores only non-zero values."),
        segment(10, 22, "Sparse attention attends to a subset of tokens."),
        segment(22, 34, "Windowed attention keeps memory linear."),
      ],
      34,
    );
    // Cues never span more than the 25-second minimum target, so the third
    // passage starts a new cue instead of producing one 34-second passage.
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      start: 0,
      end: 22,
      text: "A sparse matrix stores only non-zero values. Sparse attention attends to a subset of tokens.",
    });
    expect(cues[1]).toEqual({
      start: 22,
      end: 34,
      text: "Windowed attention keeps memory linear.",
    });
    expect(cues.every((cue) => cue.end - cue.start <= 25)).toBe(true);
  });

  it("keeps every cue inside the existing 220-passage ingestion limit for a long recording", () => {
    const segments = Array.from({ length: 900 }, (_, index) =>
      segment(index * 10, index * 10 + 9.5, `Passage number ${index} explains a concept.`),
    );
    const cues = buildTranscriptCues(segments, 9000);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.length).toBeLessThanOrEqual(220);
    expect(cues[0]?.start).toBe(0);
    expect(cues.at(-1)?.end).toBe(8999.5);
    expect(cues.at(-1)?.text).toContain("Passage number 899");
  });

  it("produces WebVTT the existing caption ingester reads back unchanged", () => {
    const cues = buildTranscriptCues(
      [segment(0, 12.5, "First idea."), segment(12.5, 30, "Second idea.")],
      30,
    );
    const vtt = buildTranscriptVtt(cues);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:12.500");
    expect(vtt).toContain("00:00:12.500 --> 00:00:30.000");
    const parsed = parseCaptions(vtt);
    expect(parsed).toEqual([
      { start: 0, end: 12.5, text: "First idea." },
      { start: 12.5, end: 30, text: "Second idea." },
    ]);
  });
});

describe("ingestion state predicates", () => {
  it("polls only while work is pending and enables features only when ready", () => {
    expect(isIngestionActive("queued")).toBe(true);
    expect(isIngestionActive("processing")).toBe(true);
    expect(isIngestionActive("ready")).toBe(false);
    expect(isIngestionActive("needs_captions")).toBe(false);
    expect(isIngestionActive("failed")).toBe(false);
    expect(isIngestionReady("ready")).toBe(true);
    expect(isIngestionReady("processing")).toBe(false);
    expect(isIngestionReady(undefined)).toBe(false);
  });
});
