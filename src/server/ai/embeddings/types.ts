export type EmbeddingMetric = "cosine" | "dot" | "euclidean";

/**
 * A model descriptor is part of the index contract. Changing the model,
 * dimension or version creates a different embedding space.
 */
export interface EmbeddingModelDescriptor {
  providerId: string;
  modelId: string;
  dimension: number;
  maxInputChars: number;
  maxBatchSize: number;
  metric: EmbeddingMetric;
  /** Bump when the same model id is re-released with incompatible vectors. */
  spaceVersion: string;
}

export interface EmbeddingSpace {
  providerId: string;
  modelId: string;
  dimension: number;
  version: string;
}

export interface EmbeddingInput {
  inputs: string[];
  signal?: AbortSignal;
  correlationId?: string;
}

export interface EmbeddingUsage {
  inputTokens?: number;
  source: "provider" | "estimated" | "unknown";
}

export interface EmbeddingResult {
  vectors: number[][];
  space: EmbeddingSpace;
  usage: EmbeddingUsage;
  correlationId: string;
  latencyMs: number;
}

export interface ProviderEmbeddingOutput {
  vectors: number[][];
  usage?: { inputTokens?: number; source?: EmbeddingUsage["source"] };
}

export type EmbeddingPurpose = "query" | "document";

export interface EmbeddingProvider {
  readonly id: string;
  readonly models: readonly EmbeddingModelDescriptor[];
  isConfigured(): boolean;
  embed(
    inputs: string[],
    model: EmbeddingModelDescriptor,
    options: { signal?: AbortSignal; correlationId: string; purpose?: EmbeddingPurpose },
  ): Promise<ProviderEmbeddingOutput>;
}

export interface EmbeddingIndexMetadata {
  indexId: string;
  space: EmbeddingSpace;
  status: "ready" | "building" | "stale" | "unavailable";
  createdAt: number;
  updatedAt: number;
}

export type RetrievalMode = "semantic" | "keyword";

export interface RetrievalModeDecision {
  mode: RetrievalMode;
  reason:
    | "compatible_index"
    | "no_index"
    | "index_not_ready"
    | "no_query_embedding_space"
    | "space_mismatch";
}
