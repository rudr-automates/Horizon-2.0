import type { TranscriptSegment } from "@/lib/learning";

export interface RagChunk {
  index: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
  wordCount: number;
}

export interface ChunkOptions {
  /** Words per chunk before a boundary is preferred. */
  targetWords?: number;
  /** Hard upper bound; a single cue longer than this is split first. */
  maxWords?: number;
  /** Words repeated from the previous chunk to preserve cross-boundary context. */
  overlapWords?: number;
  /** A chunk never spans more than this many seconds. */
  maxSpanSeconds?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  targetWords: 110,
  maxWords: 170,
  overlapWords: 28,
  // Kept short so a long provider segment cannot hide the opening of a lesson
  // behind a minute-long eligibility gate.
  maxSpanSeconds: 45,
};

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function clean(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  return parts.map(clean).filter(Boolean);
}

/**
 * Turns cue-sized transcript segments into paragraph-sized atoms. A long cue
 * is split at sentence boundaries with a proportional share of its duration so
 * every atom still carries an honest time range.
 */ function toAtoms(
  segments: TranscriptSegment[],
  maxWords: number,
  maxSpanSeconds: number,
): TranscriptSegment[] {
  const atoms: TranscriptSegment[] = [];
  for (const segment of [...segments].sort((a, b) => a.start - b.start)) {
    const text = clean(segment.text);
    if (!text) continue;
    const start = Math.max(0, segment.start);
    const duration = Math.max(0.05, segment.end - start);
    if (words(text) <= maxWords && duration <= maxSpanSeconds) {
      atoms.push({ start, end: start + duration, text });
      continue;
    }

    // Provider transcripts sometimes return one 60-second multi-sentence
    // segment. A chunk that long cannot be shown until its end, so split it by
    // sentence (and by words when a single sentence is still too long).
    const sentences = splitSentences(text);
    const initial = sentences.length ? sentences : [text];
    const totalInitialChars = initial.reduce((sum, piece) => sum + piece.length, 0) || 1;
    const pieces: string[] = [];
    for (const piece of initial) {
      const share = (duration * piece.length) / totalInitialChars;
      const groups = Math.max(1, Math.ceil(share / maxSpanSeconds));
      const tokens = piece.split(/\s+/);
      const perGroup = Math.ceil(tokens.length / groups);
      for (let index = 0; index < tokens.length; index += perGroup) {
        const part = tokens.slice(index, index + perGroup).join(" ");
        if (part) pieces.push(part);
      }
    }
    const totalChars = pieces.reduce((sum, piece) => sum + piece.length, 0) || 1;
    let cursor = start;
    pieces.forEach((piece, index) => {
      const share =
        index === pieces.length - 1
          ? start + duration - cursor
          : (duration * piece.length) / totalChars;
      const end = Math.max(cursor + 0.05, cursor + share);
      atoms.push({ start: cursor, end, text: piece });
      cursor = end;
    });
  }
  return atoms;
}

/**
 * Builds overlapping, chronological chunks that retain their source timestamps.
 * Chunks never cross the lesson duration and never contain text from outside a
 * segment's own time range. This function is pure so it can be reused for PDFs,
 * slides and notes later.
 */
export function chunkTranscript(
  segments: TranscriptSegment[],
  options: ChunkOptions = {},
): RagChunk[] {
  const config = { ...DEFAULTS, ...options };
  const targetWords = Math.max(20, Math.floor(config.targetWords));
  const maxWords = Math.max(targetWords, Math.floor(config.maxWords));
  const overlapWords = Math.max(0, Math.min(Math.floor(config.overlapWords), targetWords - 1));
  const atoms = toAtoms(segments, maxWords, config.maxSpanSeconds);
  if (!atoms.length) return [];

  const chunks: RagChunk[] = [];
  let cursor = 0;
  while (cursor < atoms.length) {
    let end = cursor;
    let count = 0;
    while (end < atoms.length) {
      const next = atoms[end]!;
      const wouldExceedWords = count + words(next.text) > maxWords;
      const wouldExceedSpan = count > 0 && next.end - atoms[cursor]!.start > config.maxSpanSeconds;
      if (count > 0 && (wouldExceedWords || wouldExceedSpan)) break;
      count += words(next.text);
      end += 1;
      if (count >= targetWords) break;
    }

    const slice = atoms.slice(cursor, end);
    const text = slice
      .map((atom) => atom.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) {
      chunks.push({
        index: chunks.length,
        text,
        startSeconds: slice[0]!.start,
        endSeconds: slice.at(-1)!.end,
        wordCount: words(text),
      });
    }

    if (end >= atoms.length) break;
    // Rewind into the previous chunk for a bounded overlap, but always move
    // forward so a large cue cannot trap the loop.
    let next = end;
    let overlap = 0;
    for (let index = end - 1; index > cursor; index -= 1) {
      overlap += words(atoms[index]!.text);
      if (overlap > overlapWords) break;
      next = index;
    }
    cursor = Math.max(cursor + 1, next);
  }

  return chunks;
}
