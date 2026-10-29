import { isCompatibleSpace } from "./space";
import type { EmbeddingIndexMetadata, EmbeddingSpace, RetrievalModeDecision } from "./types";

/**
 * Semantic retrieval is allowed only when a ready index and the query share the
 * exact embedding space. Anything else falls back to keyword retrieval; we never
 * compare vectors from different models.
 */
export function chooseRetrievalMode(
  index: EmbeddingIndexMetadata | null | undefined,
  querySpace: EmbeddingSpace | null | undefined,
): RetrievalModeDecision {
  if (!index) return { mode: "keyword", reason: "no_index" };
  if (index.status !== "ready") return { mode: "keyword", reason: "index_not_ready" };
  if (!querySpace) return { mode: "keyword", reason: "no_query_embedding_space" };
  if (!isCompatibleSpace(index.space, querySpace)) {
    return { mode: "keyword", reason: "space_mismatch" };
  }
  return { mode: "semantic", reason: "compatible_index" };
}
