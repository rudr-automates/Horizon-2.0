import type { EvidenceChunk, RetrievalMatch } from "./types";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export function tokenizeForSearch(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_+#.-]*/g) ?? [];
  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Lexical retrieval used when no compatible semantic index exists. It only
 * returns chunks that share a query term; a zero-score chunk is never included.
 * Callers must scope and authorize `chunks` first.
 */
export function keywordRetrieve(
  query: string,
  chunks: EvidenceChunk[],
  options: { limit?: number } = {},
): RetrievalMatch[] {
  const limit = options.limit ?? 6;
  if (!Number.isInteger(limit) || limit < 1) return [];

  const queryTokens = [...new Set(tokenizeForSearch(query))];
  if (!queryTokens.length || !chunks.length) return [];

  const tokenized = chunks.map((chunk) => {
    const tokens = tokenizeForSearch(`${chunk.provenance?.title ?? ""} ${chunk.text}`);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { chunk, tokens, frequencies };
  });

  const documentFrequency = new Map<string, number>();
  for (const { frequencies } of tokenized) {
    for (const token of queryTokens) {
      if (frequencies.has(token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }

  const matches: RetrievalMatch[] = [];
  for (const { chunk, tokens, frequencies } of tokenized) {
    let score = 0;
    for (const token of queryTokens) {
      const frequency = frequencies.get(token) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(token) ?? 1;
      const idf = Math.log(1 + (tokenized.length + 1) / (df + 1));
      const lengthNorm = 1 / (1 + Math.log(1 + tokens.length));
      score += frequency * idf * lengthNorm;
    }
    if (score > 0) matches.push({ chunk, score: Math.round(score * 1_000_000) / 1_000_000 });
  }

  return matches
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit);
}
