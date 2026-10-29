import { EmbeddingError } from "./errors";
import type { EmbeddingModelDescriptor, EmbeddingSpace } from "./types";

export function embeddingSpaceFor(model: EmbeddingModelDescriptor): EmbeddingSpace {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    dimension: model.dimension,
    version: model.spaceVersion,
  };
}

/**
 * Stable storage key. Different provider/model/dimension/version combinations
 * must never share a key, because their vectors are not comparable.
 */
export function embeddingSpaceKey(space: EmbeddingSpace): string {
  return [
    encodeURIComponent(space.providerId),
    encodeURIComponent(space.modelId),
    space.dimension,
    encodeURIComponent(space.version),
  ].join(":");
}

export function isCompatibleSpace(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.dimension === b.dimension &&
    a.version === b.version
  );
}

export function assertCompatibleSpace(index: EmbeddingSpace, query: EmbeddingSpace): void {
  if (!isCompatibleSpace(index, query)) {
    throw new EmbeddingError(
      "space_mismatch",
      "The query embedding space is incompatible with the indexed vectors; use keyword retrieval or reindex.",
      { providerId: query.providerId, modelId: query.modelId },
    );
  }
}

export function validateEmbeddingSpace(space: EmbeddingSpace): void {
  if (!space.providerId.trim() || !space.modelId.trim() || !space.version.trim()) {
    throw new EmbeddingError("invalid_response", "Embedding space identifiers must be non-empty.");
  }
  if (!Number.isInteger(space.dimension) || space.dimension <= 0) {
    throw new EmbeddingError(
      "dimension_mismatch",
      "Embedding dimension must be a positive integer.",
    );
  }
}
