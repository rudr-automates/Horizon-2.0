import { EmbeddingError } from "./errors";
import type { EmbeddingModelDescriptor } from "./types";

export interface EmbeddingBatchLimits {
  maxBatchSize: number;
  maxInputChars: number;
  maxTotalChars: number;
}

export const DEFAULT_EMBEDDING_LIMITS: EmbeddingBatchLimits = {
  maxBatchSize: 32,
  maxInputChars: 8_000,
  maxTotalChars: 64_000,
};

/**
 * Rejects oversized or empty batches instead of truncating text. Silent
 * truncation would change what was indexed without telling the learner.
 */
export function validateEmbeddingInputs(
  inputs: string[],
  model: EmbeddingModelDescriptor,
  limits: EmbeddingBatchLimits = DEFAULT_EMBEDDING_LIMITS,
): void {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new EmbeddingError("invalid_batch", "At least one input is required.", {
      providerId: model.providerId,
      modelId: model.modelId,
    });
  }

  const maxBatch = Math.min(model.maxBatchSize, limits.maxBatchSize);
  if (inputs.length > maxBatch) {
    throw new EmbeddingError(
      "too_many_inputs",
      `This batch has ${inputs.length} inputs; the limit is ${maxBatch}.`,
      { providerId: model.providerId, modelId: model.modelId },
    );
  }

  const maxChars = Math.min(model.maxInputChars, limits.maxInputChars);
  let total = 0;
  for (const input of inputs) {
    if (typeof input !== "string" || !input.trim()) {
      throw new EmbeddingError("empty_input", "Embedding inputs must be non-empty text.", {
        providerId: model.providerId,
        modelId: model.modelId,
      });
    }
    if (input.length > maxChars) {
      throw new EmbeddingError(
        "input_too_large",
        `An embedding input exceeds the ${maxChars}-character limit. Split it into chunks first.`,
        { providerId: model.providerId, modelId: model.modelId },
      );
    }
    total += input.length;
  }
  if (total > limits.maxTotalChars) {
    throw new EmbeddingError(
      "batch_too_large",
      `The batch exceeds the ${limits.maxTotalChars}-character total limit.`,
      { providerId: model.providerId, modelId: model.modelId },
    );
  }
}

export function validateEmbeddingVectors(
  vectors: number[][],
  expectedCount: number,
  expectedDimension: number,
  providerId: string,
  modelId: string,
): void {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingError(
      "invalid_response",
      "The embedding provider returned the wrong number of vectors.",
      { providerId, modelId },
    );
  }
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== expectedDimension) {
      throw new EmbeddingError(
        "dimension_mismatch",
        `An embedding vector does not have the declared ${expectedDimension} dimensions.`,
        { providerId, modelId },
      );
    }
    for (const value of vector) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EmbeddingError(
          "invalid_response",
          "The embedding provider returned a non-finite vector value.",
          { providerId, modelId },
        );
      }
    }
  }
}
