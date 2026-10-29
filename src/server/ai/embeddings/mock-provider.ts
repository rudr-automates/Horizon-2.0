import { EmbeddingError } from "./errors";
import type { EmbeddingModelDescriptor, EmbeddingProvider, ProviderEmbeddingOutput } from "./types";

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function unitVector(text: string, dimension: number): number[] {
  let seed = hashText(text);
  const values: number[] = [];
  for (let index = 0; index < dimension; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push((seed / 0x1_0000_0000) * 2 - 1);
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return values.map((_, index) => (index === 0 ? 1 : 0));
  return values.map((value) => value / norm);
}

/**
 * Deterministic embeddings for unit tests. No network, no credentials, no
 * provider quota. The vector for a given (text, dimension) is stable.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly models: readonly EmbeddingModelDescriptor[];
  readonly calls: Array<{ modelId: string; count: number; chars: number }> = [];
  readonly #configured: boolean;
  #failure: EmbeddingError | undefined;
  #hang = false;

  constructor(
    options: {
      id?: string;
      configured?: boolean;
      dimension?: number;
      modelId?: string;
      spaceVersion?: string;
    } = {},
  ) {
    this.id = options.id ?? "mock-embed";
    this.#configured = options.configured ?? true;
    this.models = [
      {
        providerId: this.id,
        modelId: options.modelId ?? "mock-embedding-model",
        dimension: options.dimension ?? 8,
        maxInputChars: 8_000,
        maxBatchSize: 32,
        metric: "cosine",
        spaceVersion: options.spaceVersion ?? "v1",
      },
    ];
  }

  failNext(error?: EmbeddingError): this {
    this.#failure =
      error ??
      new EmbeddingError("provider_unavailable", "Mock provider failure.", {
        providerId: this.id,
      });
    return this;
  }

  hangNext(): this {
    this.#hang = true;
    return this;
  }

  isConfigured(): boolean {
    return this.#configured;
  }

  async embed(
    inputs: string[],
    model: EmbeddingModelDescriptor,
    options: { signal?: AbortSignal; correlationId: string },
  ): Promise<ProviderEmbeddingOutput> {
    this.calls.push({
      modelId: model.modelId,
      count: inputs.length,
      chars: inputs.reduce((sum, input) => sum + input.length, 0),
    });
    if (options.signal?.aborted) {
      throw new EmbeddingError("aborted", "The embedding request was cancelled.");
    }
    if (this.#hang) {
      this.#hang = false;
      return new Promise<ProviderEmbeddingOutput>(() => {});
    }
    if (this.#failure) {
      const failure = this.#failure;
      this.#failure = undefined;
      throw failure;
    }
    return {
      vectors: inputs.map((input) => unitVector(input, model.dimension)),
      usage: {
        inputTokens: Math.max(1, Math.ceil(inputs.join(" ").length / 4)),
        source: "estimated",
      },
    };
  }
}
