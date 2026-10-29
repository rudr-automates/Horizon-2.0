import { readFile } from "node:fs/promises";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  chunkPlainText,
  extractResource,
  ExtractionError,
} from "@/server/ingestion/extract.server";

function pptxFixture(): Uint8Array {
  const slide = (text: string) =>
    `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t xml:space="preserve">${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "ppt/presentation.xml": strToU8("<p:presentation/>"),
    "ppt/slides/slide1.xml": strToU8(
      slide("Neurons combine a linear function with a non-linear activation."),
    ),
    "ppt/slides/slide2.xml": strToU8(
      slide("ReLU passes positive values through and clamps negatives to zero."),
    ),
    "ppt/notesSlides/notesSlide2.xml": strToU8(
      '<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Mention vanishing gradients.</a:t></p:notes>',
    ),
  });
}

describe("text chunking", () => {
  it("keeps paragraphs, respects the maximum size and never returns empty chunks", () => {
    const paragraph = "Deep learning builds layered representations. ".repeat(40);
    const text = `${paragraph}\n\n${paragraph}\n\nShort closing paragraph.`;
    const chunks = chunkPlainText(text, { targetChars: 400, maxChars: 700 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 700)).toBe(true);
    expect(chunks.join(" ")).toContain("Short closing paragraph.");
    expect(chunks.join(" ")).toContain("layered representations");
  });
});

describe("resource extraction", () => {
  it("extracts plain text and code with text locators", async () => {
    const notes = await extractResource({
      filename: "lecture-notes.txt",
      lessonId: "lesson-1",
      bytes: strToU8("A neuron receives inputs.\n\nAn activation function adds non-linearity."),
    });
    expect(notes.kind).toBe("text");
    expect(notes.chunks.length).toBe(1);
    expect(notes.chunks[0]?.locator.kind).toBe("text");

    const code = await extractResource({
      filename: "hybrid_search.py",
      lessonId: "lesson-1",
      bytes: strToU8("def fuse(a, b):\n    return a + b\n"),
    });
    expect(code.kind).toBe("code");
    expect(code.metadata["extension"]).toBe(".py");
  });

  it("parses WebVTT into timestamped, lesson-scoped video evidence", async () => {
    const captions = `WEBVTT

00:00:01.000 --> 00:00:04.000
An embedding represents meaning.

00:00:04.500 --> 00:00:08.000
Related meanings land near each other.`;
    const result = await extractResource({
      filename: "captions.vtt",
      lessonId: "lesson-embedding",
      lessonDurationSeconds: 60,
      bytes: strToU8(captions),
    });
    expect(result.kind).toBe("video_transcript");
    expect(result.chunks).toHaveLength(1);
    const locator = result.chunks[0]?.locator;
    expect(locator?.kind).toBe("video");
    if (locator?.kind === "video") {
      expect(locator.lessonId).toBe("lesson-embedding");
      expect(locator.startSeconds).toBe(1);
      expect(locator.endSeconds).toBe(8);
    }
  });

  it("rejects captions that run past the lesson duration", async () => {
    const captions = `WEBVTT

00:00:50.000 --> 00:01:20.000
This runs past the stored lesson duration.`;
    await expect(
      extractResource({
        filename: "captions.vtt",
        lessonId: "lesson-1",
        lessonDurationSeconds: 60,
        bytes: strToU8(captions),
      }),
    ).rejects.toMatchObject({ code: "transcript_mismatch" });
  });

  it("extracts slide text and speaker notes with slide locators", async () => {
    const result = await extractResource({
      filename: "neural-networks.pptx",
      lessonId: "lesson-1",
      bytes: pptxFixture(),
    });
    expect(result.kind).toBe("slides");
    expect(result.chunks).toHaveLength(2);
    expect(result.metadata["slideCount"]).toBe(2);
    expect(result.chunks[0]?.locator).toEqual({ kind: "slide", slideNumber: 1 });
    expect(result.chunks[0]?.text).toContain("linear function");
    expect(result.chunks[1]?.text).toContain("Speaker notes");
    expect(result.chunks[1]?.text).toContain("vanishing gradients");
  });

  it("rejects legacy binary PowerPoint files with an actionable message", async () => {
    await expect(
      extractResource({
        filename: "old-deck.ppt",
        lessonId: "lesson-1",
        bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
      }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it("extracts selectable text and page locators from the real MIT lecture PDF", async () => {
    const pdf = await readFile("public/course/mit-15-773/mit15_773_s24_lec01.pdf");
    const result = await extractResource({
      filename: "mit15_773_s24_lec01.pdf",
      lessonId: "mit-15-773-01",
      bytes: new Uint8Array(pdf),
    });
    expect(result.kind).toBe("pdf");
    expect(result.metadata["pageCount"]).toBeGreaterThan(50);
    expect(result.chunks.length).toBeGreaterThan(50);
    expect(result.chunks[0]?.locator).toEqual({ kind: "page", pageNumber: 1 });
    expect(result.chunks.some((chunk) => /neural|network/i.test(chunk.text))).toBe(true);
    expect(result.chunks.every((chunk) => chunk.text.length <= 1_400)).toBe(true);
  }, 60_000);
});
