import { describe, expect, it } from "vitest";
import {
  activeSegment,
  clampPosition,
  courseCompletion,
  parseCaptions,
  parseVideoUrl,
  watchedDelta,
} from "@/lib/learning";

describe("Learning Studio rules", () => {
  it("highlights the current segment with an exclusive end boundary", () => {
    const segments = [
      { start: 0, end: 15.76, text: "one" },
      { start: 15.76, end: 36.72, text: "two" },
    ];
    expect(activeSegment(segments, 15.76)).toBe(1);
    expect(activeSegment(segments, 36.72)).toBe(-1);
  });
  it("resumes only within the actual video duration", () => {
    expect(clampPosition(100, 56.2)).toBe(56.2);
    expect(clampPosition(-2, 56.2)).toBe(0);
  });
  it("does not count seeking to the end as watched time", () => {
    expect(watchedDelta(0, 56.2, 1, true, false)).toBe(0);
    expect(watchedDelta(0, 1, 1, true, true)).toBe(0);
    expect(watchedDelta(0, 1, 1, true, false)).toBe(1);
  });
  it("completion depends on explicit completed lessons, not playback position", () => {
    expect(
      courseCompletion(
        ["a", "b", "c"],
        [
          { lesson_id: "a", completed: true },
          { lesson_id: "b", completed: false },
        ],
      ),
    ).toBe(33);
  });
  it("preserves supplied SRT timestamps", () => {
    expect(parseCaptions("1\n00:00:15,760 --> 00:00:36,720\nMeaning, not probability.")).toEqual([
      { start: 15.76, end: 36.72, text: "Meaning, not probability." },
    ]);
  });
  it("skips WebVTT NOTE, STYLE and REGION blocks instead of rejecting the file", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE",
      "Synthetic caption track written for local acceptance testing.",
      "It is not a transcript of a real lecture.",
      "",
      "1",
      "00:00:00.000 --> 00:00:06.000",
      "Memory decays over time.",
      "",
      "STYLE",
      "::cue { color: yellow } ",
      "",
      "2",
      "00:00:06.000 --> 00:00:12.000",
      "A well-timed review resets that decay.",
    ].join("\n");
    expect(parseCaptions(vtt)).toEqual([
      { start: 0, end: 6, text: "Memory decays over time." },
      { start: 6, end: 12, text: "A well-timed review resets that decay." },
    ]);
  });
  it("still rejects a block that has text but no timing", () => {
    expect(() => parseCaptions("WEBVTT\n\njust some words\n")).toThrow();
  });
  it("rejects out-of-order caption ranges", () => {
    expect(() =>
      parseCaptions("00:00:05.000 --> 00:00:09.000\none\n\n00:00:08.000 --> 00:00:10.000\ntwo"),
    ).toThrow();
  });
  it("accepts supported provider links without fetching them server-side", () => {
    expect(parseVideoUrl("https://youtu.be/aircAruvnKk").provider).toBe("youtube");
    expect(parseVideoUrl("https://vimeo.com/123456").provider).toBe("vimeo");
    expect(parseVideoUrl("https://example.com/lesson.mp4").provider).toBe("direct");
  });
  it("rejects local addresses and unsupported sites", () => {
    expect(() => parseVideoUrl("https://127.0.0.1/a.mp4")).toThrow();
    expect(() => parseVideoUrl("https://example.com/page")).toThrow();
  });
});
