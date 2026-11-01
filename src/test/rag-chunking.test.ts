import { describe, expect, it } from "vitest";
import { chunkTranscript } from "@/server/rag/chunking";

const words = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");

describe("chunkTranscript", () => {
  it("keeps chronological timestamps and bounded, overlapping chunks", () => {
    const segments = Array.from({ length: 12 }, (_, index) => ({
      start: index * 20,
      end: index * 20 + 19,
      text: words(10, `w${index}-`),
    }));

    const chunks = chunkTranscript(segments, {
      targetWords: 60,
      maxWords: 90,
      overlapWords: 15,
      maxSpanSeconds: 180,
    });

    expect(chunks.length).toBeGreaterThan(2);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      expect(chunk.index).toBe(index);
      expect(chunk.startSeconds).toBeGreaterThanOrEqual(0);
      expect(chunk.endSeconds).toBeGreaterThan(chunk.startSeconds);
      expect(chunk.text.trim()).not.toBe("");
      expect(chunk.wordCount).toBeLessThanOrEqual(90);
      if (index > 0) {
        expect(chunk.startSeconds).toBeGreaterThanOrEqual(chunks[index - 1]!.startSeconds);
        expect(chunk.endSeconds).toBeGreaterThan(chunks[index - 1]!.endSeconds);
      }
    }

    const first = chunks[0]!.text.split(/\s+/);
    const second = chunks[1]!.text.split(/\s+/);
    // Overlap is taken in whole cues: the last 10-word cue is repeated.
    const trailing = first.slice(-10).join(" ");
    expect(second.join(" ").startsWith(trailing)).toBe(true);
  });

  it("splits an oversized cue at sentence boundaries with honest times", () => {
    const sentence = `${words(40, "s-")}. `;
    const text = Array.from({ length: 8 }, () => sentence)
      .join(" ")
      .trim();
    const chunks = chunkTranscript([{ start: 10, end: 110, text }], {
      targetWords: 80,
      maxWords: 120,
      overlapWords: 20,
      maxSpanSeconds: 60,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.startSeconds).toBe(10);
    expect(chunks.at(-1)!.endSeconds).toBeLessThanOrEqual(110.001);
    for (const chunk of chunks) {
      expect(chunk.wordCount).toBeLessThanOrEqual(140);
      expect(chunk.endSeconds).toBeGreaterThan(chunk.startSeconds);
    }
  });

  it("splits a long low-word segment by time so early positions are eligible", () => {
    const text = Array.from(
      { length: 4 },
      (_, index) => `Sentence ${index} explains one idea in enough detail to be useful.`,
    ).join(" ");
    const chunks = chunkTranscript([{ start: 0, end: 120, text }]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]!.endSeconds).toBeLessThanOrEqual(45.1);
    expect(chunks.at(-1)!.endSeconds).toBeLessThanOrEqual(120.001);
    for (const chunk of chunks) {
      expect(chunk.endSeconds - chunk.startSeconds).toBeLessThanOrEqual(45.1);
    }
  });

  it("returns no chunks for empty or invalid segments", () => {
    expect(chunkTranscript([])).toEqual([]);
    expect(chunkTranscript([{ start: -1, end: 0, text: "   " }])).toEqual([]);
  });
});
