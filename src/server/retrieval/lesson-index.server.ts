import { JINA_EMBEDDING_MODEL } from "../ai/embeddings/jina";
import { embeddingSpaceFor, embeddingSpaceKey } from "../ai/embeddings/space";
import type { EmbeddingService } from "../ai/embeddings/service";
import type { EvidenceChunk } from "./types";

const VECTOR_CACHE_LIMIT = 4_000;
const MAX_INLINE_CHUNKS = 80;
const SPACE = embeddingSpaceKey(embeddingSpaceFor(JINA_EMBEDDING_MODEL));
const chunkCache = new Map<string, number[]>();
const queryCache = new Map<string, number[]>();

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function cacheChunk(key: string, vector: number[]): void {
  if (chunkCache.size >= VECTOR_CACHE_LIMIT) {
    const oldest = chunkCache.keys().next().value;
    if (oldest !== undefined) chunkCache.delete(oldest);
  }
  chunkCache.set(key, vector);
}

export interface LessonVectors {
  vectors: Map<string, number[]>;
  semanticAvailable: boolean;
  reason?: "not_configured" | "too_many_chunks" | "provider_error";
}

/**
 * Embeds only eligible, already-authorized chunks. The cache is keyed by the
 * exact embedding space plus content, so a model or version change cannot reuse
 * an incompatible vector. Large indexes must be precomputed by ingestion; this
 * request-time path deliberately refuses unbounded fan-out.
 */
export async function embedLessonChunks(
  chunks: EvidenceChunk[],
  embeddings: EmbeddingService,
): Promise<LessonVectors> {
  if (!chunks.length) return { vectors: new Map(), semanticAvailable: false };

  const vectors = new Map<string, number[]>();
  const missing: Array<{ chunk: EvidenceChunk; key: string }> = [];
  for (const chunk of chunks) {
    // Prefer embeddings produced by the ingestion job, but only from this exact
    // model/dimension/version. A stale index must fall back, never be compared.
    if (chunk.embedding && chunk.embeddingSpaceKey === SPACE) {
      vectors.set(chunk.id, chunk.embedding);
      continue;
    }
    const key = `${SPACE}:${hashText(chunk.text)}`;
    const cached = chunkCache.get(key);
    if (cached) vectors.set(chunk.id, cached);
    else missing.push({ chunk, key });
  }

  if (missing.length > MAX_INLINE_CHUNKS) {
    return {
      vectors,
      semanticAvailable: vectors.size > 0,
      reason: "too_many_chunks",
    };
  }

  try {
    for (let start = 0; start < missing.length; start += 32) {
      const batch = missing.slice(start, start + 32);
      const result = await embeddings.embed({
        providerId: JINA_EMBEDDING_MODEL.providerId,
        modelId: JINA_EMBEDDING_MODEL.modelId,
        inputs: batch.map((item) => item.chunk.text),
        purpose: "document",
      });
      result.vectors.forEach((vector, index) => {
        const item = batch[index];
        if (!item) return;
        cacheChunk(item.key, vector);
        vectors.set(item.chunk.id, vector);
      });
    }
    return { vectors, semanticAvailable: vectors.size > 0 };
  } catch {
    return { vectors, semanticAvailable: false, reason: "provider_error" };
  }
}

export async function embedQuery(
  question: string,
  embeddings: EmbeddingService,
): Promise<number[] | null> {
  const key = `${SPACE}:${hashText(question)}`;
  const cached = queryCache.get(key);
  if (cached) return cached;
  try {
    const result = await embeddings.embed({
      providerId: JINA_EMBEDDING_MODEL.providerId,
      modelId: JINA_EMBEDDING_MODEL.modelId,
      inputs: [question],
      purpose: "query",
      timeoutMs: 20_000,
    });
    const vector = result.vectors[0];
    if (!vector) return null;
    if (queryCache.size > 500) queryCache.clear();
    queryCache.set(key, vector);
    return vector;
  } catch {
    return null;
  }
}
