import { unzipSync } from "fflate";
import { parseCaptions, type TranscriptSegment } from "@/lib/learning";
import type { EvidenceLocator, ResourceKind } from "../retrieval/types";

export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_RESOURCE_CHUNKS = 220;
const TARGET_CHUNK_CHARS = 900;
const MAX_CHUNK_CHARS = 1_400;

export type ExtractionErrorCode =
  | "unsupported_type"
  | "legacy_ppt_unsupported"
  | "invalid_file"
  | "empty_content"
  | "too_many_chunks"
  | "invalid_transcript"
  | "transcript_mismatch"
  | "pdf_unreadable";

export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;

  constructor(code: ExtractionErrorCode, message: string) {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
  }
}

export interface ExtractedChunk {
  heading?: string;
  text: string;
  locator: EvidenceLocator;
}

export interface ExtractionResult {
  kind: ResourceKind;
  title: string;
  chunks: ExtractedChunk[];
  metadata: Record<string, unknown>;
}

export interface ExtractInput {
  filename: string;
  bytes: Uint8Array;
  lessonId: string;
  mimeType?: string;
  lessonDurationSeconds?: number;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function normalizeParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/);
  const output: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      if (current.trim()) output.push(current.trim());
      current = "";
      for (let start = 0; start < sentence.length; start += maxChars) {
        output.push(sentence.slice(start, start + maxChars).trim());
      }
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars && current.trim()) {
      output.push(current.trim());
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) output.push(current.trim());
  return output.filter(Boolean);
}

/** Chunks on paragraph boundaries and never drops content. */
export function chunkPlainText(
  text: string,
  options: { targetChars?: number; maxChars?: number } = {},
): string[] {
  const target = options.targetChars ?? TARGET_CHUNK_CHARS;
  const max = options.maxChars ?? MAX_CHUNK_CHARS;
  const normalized = normalizeParagraphs(text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    const pieces =
      paragraph.length > max
        ? splitLongText(paragraph, max)
        : [paragraph.replace(/\s+/g, " ").trim()];
    for (const piece of pieces) {
      if (!piece) continue;
      if (current.length + piece.length + 2 > target && current.trim()) flush();
      if (piece.length > max) {
        flush();
        chunks.push(...splitLongText(piece, max));
        continue;
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();
  return chunks;
}

function splitCaption(segment: TranscriptSegment): TranscriptSegment[] {
  if (segment.text.length <= MAX_CHUNK_CHARS) return [segment];
  const parts = splitLongText(segment.text, MAX_CHUNK_CHARS);
  const span = segment.end - segment.start;
  return parts.map((text, index) => ({
    start: segment.start + (span * index) / parts.length,
    end: segment.start + (span * (index + 1)) / parts.length,
    text,
  }));
}

function transcriptChunks(
  segments: TranscriptSegment[],
  lessonId: string,
  lessonDurationSeconds?: number,
): ExtractedChunk[] {
  const merged: TranscriptSegment[] = [];
  for (const segment of segments.flatMap(splitCaption)) {
    const current = merged.at(-1);
    if (
      current &&
      current.text.length + segment.text.length <= 1_100 &&
      segment.start - current.end <= 4 &&
      segment.end - current.start <= 20
    ) {
      current.end = segment.end;
      current.text = `${current.text} ${segment.text}`.trim();
    } else {
      merged.push({ ...segment });
    }
  }
  const lastEnd = merged.at(-1)?.end ?? 0;
  if (lessonDurationSeconds && lastEnd > lessonDurationSeconds + 5) {
    throw new ExtractionError(
      "transcript_mismatch",
      `The captions end at ${Math.round(lastEnd)}s but this lesson is ${Math.round(lessonDurationSeconds)}s long.`,
    );
  }
  return merged.map((segment, index) => ({
    heading: `Transcript part ${index + 1}`,
    text: segment.text,
    locator: {
      kind: "video" as const,
      lessonId,
      startSeconds: Number(segment.start.toFixed(3)),
      endSeconds: Number(segment.end.toFixed(3)),
    },
  }));
}

async function extractPdf(bytes: Uint8Array): Promise<{
  chunks: ExtractedChunk[];
  pageCount: number;
  skippedPages: number[];
}> {
  if (!/^%PDF-/.test(new TextDecoder().decode(bytes.slice(0, 5)))) {
    throw new ExtractionError("invalid_file", "That file is not a valid PDF.");
  }
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  let document: Awaited<typeof loading.promise>;
  try {
    document = await loading.promise;
  } catch {
    throw new ExtractionError("pdf_unreadable", "The PDF could not be opened.");
  }

  const chunks: ExtractedChunk[] = [];
  const skippedPages: number[] = [];
  const pageCount = document.numPages;
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
        else if (!/[\s-]$/.test(item.str)) text += " ";
      }
      const normalized = normalizeParagraphs(text);
      if (normalized.length < 20) {
        skippedPages.push(pageNumber);
        continue;
      }
      const passages = chunkPlainText(normalized, {
        targetChars: 850,
        maxChars: MAX_CHUNK_CHARS,
      });
      passages.forEach((passage, index) => {
        chunks.push({
          heading: `Page ${pageNumber}${passages.length > 1 ? `, part ${index + 1}` : ""}`,
          text: passage,
          locator: { kind: "page", pageNumber },
        });
      });
      page.cleanup();
    }
  } finally {
    await loading.destroy();
  }
  if (!chunks.length) {
    throw new ExtractionError(
      "empty_content",
      "No selectable text was found in this PDF. Scanned pages need OCR first.",
    );
  }
  return { chunks, pageCount, skippedPages };
}

function extractPptx(bytes: Uint8Array): {
  chunks: ExtractedChunk[];
  slideCount: number;
  skippedSlides: number[];
} {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ExtractionError("invalid_file", "That file is not a valid PPTX archive.");
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new ExtractionError("invalid_file", "The PPTX archive is damaged.");
  }
  const slideFiles = Object.keys(files)
    .map((path) => ({ path, match: path.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((entry): entry is { path: string; match: RegExpMatchArray } => entry.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (!slideFiles.length) {
    throw new ExtractionError("empty_content", "No slides were found in this presentation.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const chunks: ExtractedChunk[] = [];
  const skippedSlides: number[] = [];
  for (const slide of slideFiles) {
    const slideNumber = Number(slide.match[1]);
    const xml = decoder.decode(files[slide.path]!);
    const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeXml(match[1] ?? ""),
    );
    const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
    const notesFile = files[notesPath];
    const notes = notesFile
      ? [...decoder.decode(notesFile).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
          .map((match) => decodeXml(match[1] ?? "").trim())
          .filter((value) => value && !/^\d+$/.test(value))
          .join(" ")
      : "";

    const body = normalizeParagraphs(runs.join("\n"));
    const text = normalizeParagraphs([body, notes ? `Speaker notes: ${notes}` : ""].join("\n\n"));
    if (text.length < 10) {
      skippedSlides.push(slideNumber);
      continue;
    }
    for (const [index, passage] of chunkPlainText(text, {
      targetChars: 850,
      maxChars: MAX_CHUNK_CHARS,
    }).entries()) {
      chunks.push({
        heading: `Slide ${slideNumber}${index > 0 ? `, part ${index + 1}` : ""}`,
        text: passage,
        locator: { kind: "slide", slideNumber },
      });
    }
  }
  if (!chunks.length) {
    throw new ExtractionError(
      "empty_content",
      "The presentation contains no extractable text (it may be image-only).",
    );
  }
  return { chunks, slideCount: slideFiles.length, skippedSlides };
}

function textKind(extension: string): ResourceKind {
  if (extension === ".md" || extension === ".markdown") return "markdown";
  const code = new Set([
    "py",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "json",
    "css",
    "html",
    "java",
    "c",
    "cpp",
    "h",
    "rs",
    "go",
    "rb",
    "php",
    "sql",
    "sh",
    "yaml",
    "yml",
    "toml",
  ]);
  return code.has(extension.slice(1)) ? "code" : "text";
}

function titleFromFilename(filename: string): string {
  const base = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return (base || "Untitled resource").slice(0, 300);
}

function extensionOf(filename: string): string {
  const match = filename.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export async function extractResource(input: ExtractInput): Promise<ExtractionResult> {
  if (input.bytes.byteLength === 0) {
    throw new ExtractionError("empty_content", "The selected file is empty.");
  }
  if (input.bytes.byteLength > MAX_RESOURCE_BYTES) {
    throw new ExtractionError("invalid_file", "Files must be 10 MB or smaller.");
  }

  const extension = extensionOf(input.filename);
  const baseMetadata = {
    originalFilename: input.filename,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.bytes.byteLength,
    extension,
  };

  if (extension === ".ppt") {
    throw new ExtractionError(
      "legacy_ppt_unsupported",
      "Legacy .ppt files are not supported. Save the deck as .pptx and upload it again.",
    );
  }
  if (extension === ".pdf") {
    const pdf = await extractPdf(input.bytes);
    if (pdf.chunks.length > MAX_RESOURCE_CHUNKS) {
      throw new ExtractionError(
        "too_many_chunks",
        `That PDF would create ${pdf.chunks.length} passages; the limit is ${MAX_RESOURCE_CHUNKS}.`,
      );
    }
    return {
      kind: "pdf",
      title: titleFromFilename(input.filename),
      chunks: pdf.chunks,
      metadata: { ...baseMetadata, pageCount: pdf.pageCount, skippedPages: pdf.skippedPages },
    };
  }
  if (extension === ".pptx") {
    const slides = extractPptx(input.bytes);
    if (slides.chunks.length > MAX_RESOURCE_CHUNKS) {
      throw new ExtractionError(
        "too_many_chunks",
        `That presentation would create ${slides.chunks.length} passages; the limit is ${MAX_RESOURCE_CHUNKS}.`,
      );
    }
    return {
      kind: "slides",
      title: titleFromFilename(input.filename),
      chunks: slides.chunks,
      metadata: {
        ...baseMetadata,
        slideCount: slides.slideCount,
        skippedSlides: slides.skippedSlides,
      },
    };
  }
  if (extension === ".vtt" || extension === ".srt" || extension === ".webvtt") {
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
    let segments: TranscriptSegment[];
    try {
      segments = parseCaptions(raw);
    } catch {
      throw new ExtractionError(
        "invalid_transcript",
        "The captions are not valid, ordered SRT or WebVTT cues.",
      );
    }
    const chunks = transcriptChunks(segments, input.lessonId, input.lessonDurationSeconds);
    if (!chunks.length) throw new ExtractionError("empty_content", "The captions contain no text.");
    if (chunks.length > MAX_RESOURCE_CHUNKS) {
      throw new ExtractionError(
        "too_many_chunks",
        `That transcript would create ${chunks.length} passages; the limit is ${MAX_RESOURCE_CHUNKS}.`,
      );
    }
    return {
      kind: "video_transcript",
      title: titleFromFilename(input.filename),
      chunks,
      metadata: { ...baseMetadata, segmentCount: segments.length },
    };
  }

  const raw = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
  if (raw.includes("\u0000")) {
    throw new ExtractionError("unsupported_type", "That binary format is not supported.");
  }
  const text = normalizeParagraphs(raw);
  if (!text) throw new ExtractionError("empty_content", "The file contains no readable text.");
  const kind = textKind(extension);
  const passages = chunkPlainText(text);
  const chunks: ExtractedChunk[] = passages.map((chunk, index) => {
    const section = passages.length > 1 ? `Part ${index + 1}` : undefined;
    return {
      ...(section === undefined ? {} : { heading: section }),
      text: chunk,
      locator: { kind: "text", ...(section === undefined ? {} : { section }) },
    };
  });
  if (chunks.length > MAX_RESOURCE_CHUNKS) {
    throw new ExtractionError(
      "too_many_chunks",
      `That document would create ${chunks.length} passages; the limit is ${MAX_RESOURCE_CHUNKS}. Split it into smaller files.`,
    );
  }
  return {
    kind,
    title: titleFromFilename(input.filename),
    chunks,
    metadata: { ...baseMetadata, chunkCount: chunks.length },
  };
}
