import type { EvidenceChunk, RetrievalMatch } from "./types";
import { keywordRetrieve } from "./keyword";

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface RankedMatch extends RetrievalMatch {
  keywordScore?: number;
  semanticScore?: number;
}

export function semanticRetrieve(
  queryVector: number[],
  chunks: EvidenceChunk[],
  vectors: ReadonlyMap<string, number[]>,
  options: { limit?: number; minScore?: number } = {},
): RankedMatch[] {
  const limit = options.limit ?? 12;
  const minScore = options.minScore ?? 0.2;
  const matches: RankedMatch[] = [];
  for (const chunk of chunks) {
    const vector = vectors.get(chunk.id);
    if (!vector || vector.length !== queryVector.length) continue;
    const score = cosineSimilarity(queryVector, vector);
    if (score >= minScore) {
      matches.push({ chunk, score, semanticScore: score });
    }
  }
  return matches
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit);
}

/**
 * Reciprocal rank fusion keeps lexical and semantic evidence ordered without
 * comparing their incomparable raw scores. The constant controls how quickly
 * downward rank position loses influence.
 */
export function reciprocalRankFusion(lists: RankedMatch[][], limit = 12, k = 60): RankedMatch[] {
  const merged = new Map<string, RankedMatch>();
  lists.forEach((list) => {
    list.forEach((match, index) => {
      const current = merged.get(match.chunk.id);
      const contribution = 1 / (k + index + 1);
      if (current) {
        current.score += contribution;
        if (match.keywordScore !== undefined) current.keywordScore = match.keywordScore;
        if (match.semanticScore !== undefined) current.semanticScore = match.semanticScore;
      } else {
        merged.set(match.chunk.id, {
          chunk: match.chunk,
          score: contribution,
          ...(match.keywordScore === undefined ? {} : { keywordScore: match.keywordScore }),
          ...(match.semanticScore === undefined ? {} : { semanticScore: match.semanticScore }),
        });
      }
    });
  });
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit);
}

export function hybridRetrieve(
  query: string,
  chunks: EvidenceChunk[],
  queryVector: number[] | null,
  vectors: ReadonlyMap<string, number[]>,
  options: { limit?: number } = {},
): { matches: RankedMatch[]; strategy: "keyword" | "hybrid" } {
  const limit = options.limit ?? 12;
  const keyword = keywordRetrieve(query, chunks, { limit: Math.max(limit * 2, 12) }).map(
    (match): RankedMatch => ({ ...match, keywordScore: match.score }),
  );
  if (!queryVector) return { matches: keyword, strategy: "keyword" };

  const semantic = semanticRetrieve(queryVector, chunks, vectors, { limit: limit * 2 });
  if (!semantic.length) return { matches: keyword, strategy: "keyword" };

  const merged = reciprocalRankFusion(
    [keyword.map((match) => ({ ...match, keywordScore: match.score })), semantic],
    limit,
  );
  return {
    // A semantic-only hit can still be useful when the learner's wording does
    // not occur verbatim in the transcript.
    matches: merged.length ? merged : semantic,
    strategy: "hybrid",
  };
}
