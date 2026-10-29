import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\uFFFD/g, "—");
}

export function stripHtml(value) {
  return decodeEntities(
    String(value ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function normalizeText(value) {
  return (
    decodeEntities(String(value ?? ""))
      .replace(/\r/g, "")
      .replace(/\u00a0/g, " ")
      // PDF glyph maps can emit NUL and other control bytes that Postgres text
      // columns reject. Remove them before chunking or hashing.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timestampToSeconds(value) {
  const parts = value.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number.NaN;
}

function cleanCueText(lines) {
  return normalizeText(
    lines
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\[(?:squeaking|rustling|clicking|laughter|applause|music)\]/gi, " ")
      .replace(/\s+/g, " "),
  );
}

/** Parses a WebVTT caption file into timed transcript segments. */
export function parseVtt(raw) {
  const blocks = String(raw)
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n/, "")
    .trim()
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim());
    if (!lines.length || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endRaw] = lines[timingIndex].split("-->").map((part) => part.trim());
    const start = timestampToSeconds(startRaw.split(/\s+/)[0]);
    const end = timestampToSeconds((endRaw ?? "").split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = cleanCueText(lines.slice(timingIndex + 1));
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Merges tiny caption cues into readable transcript passages. The merged span
 * stays short so a question at an early timestamp never needs future speech.
 */
export function mergeTranscript(cues, options = {}) {
  const targetChars = options.targetChars ?? 600;
  const maxChars = options.maxChars ?? 1_400;
  const maxGapSeconds = options.maxGapSeconds ?? 4;
  const maxSpanSeconds = options.maxSpanSeconds ?? 20;
  const merged = [];
  for (const cue of cues) {
    const current = merged.at(-1);
    if (
      current &&
      current.text.length + cue.text.length + 1 <= targetChars &&
      cue.start - current.end <= maxGapSeconds &&
      cue.end - current.start <= maxSpanSeconds
    ) {
      current.end = cue.end;
      current.text = `${current.text} ${cue.text}`.trim();
    } else {
      merged.push({ start: cue.start, end: cue.end, text: cue.text.slice(0, maxChars) });
    }
  }
  return merged;
}

/** Splits prose into overlapping-free passages, respecting paragraph boundaries. */
export function chunkText(raw, options = {}) {
  const targetChars = options.targetChars ?? 900;
  const maxChars = options.maxChars ?? 1_500;
  const text = normalizeText(raw);
  if (!text) return [];
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      pieces.push(paragraph);
      continue;
    }
    const sentences = paragraph.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [paragraph];
    let current = "";
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > maxChars) {
        pieces.push(current.trim());
        current = "";
      }
      if (sentence.length > maxChars) {
        for (let start = 0; start < sentence.length; start += maxChars) {
          pieces.push(sentence.slice(start, start + maxChars).trim());
        }
      } else {
        current += sentence;
      }
    }
    if (current.trim()) pieces.push(current.trim());
  }

  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > targetChars) {
      chunks.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n\n${piece}` : piece;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((chunk) => chunk.length > 0);
}

/** Extracts text page by page from a PDF using pdfjs-dist's Node build. */
export async function extractPdf(filePath) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await fs.readFile(filePath));
  const loadingTask = getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
  });
  const document = await loadingTask.promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeText(
        content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .join(" ")
          .replace(/\s+([,.;:!?])/g, "$1"),
      );
      pages.push({ pageNumber, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return { pageCount: pages.length, pages };
}

/** Extracts slide text from a PPTX archive without native Office tooling. */
export async function extractPptx(filePath) {
  const archive = unzipSync(new Uint8Array(await fs.readFile(filePath)));
  const slideEntries = Object.keys(archive)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
  const slides = slideEntries.map((name, index) => {
    const xml = strFromU8(archive[name]);
    const runs = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeEntities(match[1]),
    );
    return { slideNumber: index + 1, text: normalizeText(runs.join("\n")) };
  });
  return { slideCount: slides.length, slides };
}

export function formatTimestamp(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}
