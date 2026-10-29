import type { EvidenceChunk, RetrievalMatch } from "./types";

export interface GraphExpansionOptions {
  maxExtra?: number;
  maxGapSeconds?: number;
}

export interface ConceptExpansionOptions {
  maxExtra?: number;
  /** Distinct salient terms two passages must share before a link is followed. */
  minSharedTerms?: number;
}

/**
 * A small, explicit context graph over video passages: each eligible transcript
 * chunk is linked to its immediate neighbours in playback order. Expanding a
 * retrieved hit to its neighbours gives the model the surrounding explanation
 * without ever selecting a chunk that failed scope/timestamp eligibility.
 *
 * This is deliberately a sequence graph, not a claim of Graph RAG over entities.
 */
export function expandContextGraph(
  matches: RetrievalMatch[],
  eligible: EvidenceChunk[],
  options: GraphExpansionOptions = {},
): RetrievalMatch[] {
  const maxExtra = options.maxExtra ?? 2;
  const maxGap = options.maxGapSeconds ?? 45;
  if (maxExtra < 1 || !matches.length) return matches;

  const video = eligible
    .filter(
      (chunk) => chunk.locator.kind === "video" && Number.isFinite(chunk.locator.startSeconds),
    )
    .sort((a, b) => {
      if (a.locator.kind !== "video" || b.locator.kind !== "video") return 0;
      return a.locator.startSeconds - b.locator.startSeconds || a.id.localeCompare(b.id);
    });
  if (!video.length) return matches;

  const selected = new Set(matches.map((match) => match.chunk.id));
  const output = [...matches];
  let added = 0;
  for (const match of matches) {
    if (added >= maxExtra) break;
    if (match.chunk.locator.kind !== "video") continue;
    const index = video.findIndex((chunk) => chunk.id === match.chunk.id);
    if (index < 0) continue;
    for (const neighbourIndex of [index - 1, index + 1]) {
      if (added >= maxExtra) break;
      const neighbour = video[neighbourIndex];
      if (!neighbour || selected.has(neighbour.id)) continue;
      if (neighbour.locator.kind !== "video" || match.chunk.locator.kind !== "video") continue;
      const gap =
        neighbourIndex < index
          ? match.chunk.locator.startSeconds - neighbour.locator.endSeconds
          : neighbour.locator.startSeconds - match.chunk.locator.endSeconds;
      if (gap > maxGap) continue;
      selected.add(neighbour.id);
      output.push({ chunk: neighbour, score: 0 });
      added += 1;
    }
  }
  return output;
}

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "because",
  "been",
  "before",
  "being",
  "between",
  "could",
  "does",
  "each",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "most",
  "only",
  "other",
  "over",
  "same",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "under",
  "very",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
  "upon",
  "were",
  "will",
  "also",
  "must",
  "make",
  "made",
]);

function salientTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 5 || STOPWORDS.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

function locatorRank(chunk: EvidenceChunk): number {
  return chunk.locator.kind === "video" ? 1 : 0;
}

/**
 * A second edge type over the same eligible set: passages that talk about the
 * same concepts are linked even when they live in different resources, so a
 * retrieved transcript passage can pull in the slide or PDF page that explains
 * it. Candidates are ranked by how many salient terms they share with the
 * retrieved set, with cross-resource links preferred, and the function only
 * ever receives evidence that already passed scope and timestamp checks — a
 * future passage or another learner's file cannot be introduced here.
 */
export function expandConceptLinks(
  matches: RetrievalMatch[],
  eligible: EvidenceChunk[],
  options: ConceptExpansionOptions = {},
): RetrievalMatch[] {
  const maxExtra = options.maxExtra ?? 2;
  const minShared = options.minSharedTerms ?? 3;
  if (maxExtra < 1 || !matches.length || !eligible.length) return matches;

  const selected = new Set(matches.map((match) => match.chunk.id));
  const anchorTerms = new Set<string>();
  for (const match of matches) {
    for (const term of salientTerms(match.chunk.text)) anchorTerms.add(term);
  }
  if (anchorTerms.size < minShared) return matches;

  const anchorKinds = new Set(matches.map((match) => locatorRank(match.chunk)));
  const candidates = eligible
    .filter((chunk) => !selected.has(chunk.id))
    .map((chunk) => {
      const terms = salientTerms(chunk.text);
      let shared = 0;
      for (const term of terms) if (anchorTerms.has(term)) shared += 1;
      return { chunk, shared, cross: anchorKinds.has(locatorRank(chunk)) ? 0 : 1 };
    })
    .filter((candidate) => candidate.shared >= minShared)
    .sort(
      (a, b) => b.cross - a.cross || b.shared - a.shared || a.chunk.id.localeCompare(b.chunk.id),
    );

  const output = [...matches];
  for (const candidate of candidates.slice(0, maxExtra)) {
    selected.add(candidate.chunk.id);
    output.push({ chunk: candidate.chunk, score: 0 });
  }
  return output;
}
