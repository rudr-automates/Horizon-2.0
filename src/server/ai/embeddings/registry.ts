import { EmbeddingError } from "./errors";
import type { EmbeddingModelDescriptor, EmbeddingProvider } from "./types";

export interface ResolvedEmbeddingModel {
  provider: EmbeddingProvider;
  model: EmbeddingModelDescriptor;
}

export class EmbeddingProviderRegistry {
  readonly #providers = new Map<string, EmbeddingProvider>();

  register(provider: EmbeddingProvider): this {
    const id = provider.id?.trim();
    if (!id) throw new Error("Embedding provider id must be non-empty.");
    if (id !== provider.id) {
      throw new Error("Embedding provider id must not contain surrounding whitespace.");
    }
    if (this.#providers.has(id)) {
      throw new Error(`Embedding provider "${id}" is already registered.`);
    }
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (model.providerId !== id) {
        throw new Error(`Embedding model ${model.modelId} declares a different provider id.`);
      }
      if (!model.modelId.trim() || !model.spaceVersion.trim()) {
        throw new Error("Embedding model ids and space versions must be non-empty.");
      }
      if (!Number.isInteger(model.dimension) || model.dimension <= 0) {
        throw new Error(`Embedding model ${model.modelId} has an invalid dimension.`);
      }
      if (!Number.isInteger(model.maxBatchSize) || model.maxBatchSize <= 0) {
        throw new Error(`Embedding model ${model.modelId} has an invalid batch size.`);
      }
      if (modelIds.has(model.modelId)) {
        throw new Error(`Embedding model "${model.modelId}" is registered twice.`);
      }
      modelIds.add(model.modelId);
    }
    this.#providers.set(id, provider);
    return this;
  }

  resolve(providerId: string, modelId: string): ResolvedEmbeddingModel | undefined {
    const provider = this.#providers.get(providerId);
    const model = provider?.models.find((candidate) => candidate.modelId === modelId);
    return provider && model ? { provider, model } : undefined;
  }

  require(providerId: string, modelId: string): ResolvedEmbeddingModel {
    const resolved = this.resolve(providerId, modelId);
    if (!resolved) {
      throw new EmbeddingError(
        "model_not_found",
        "The requested embedding model is not registered.",
        { providerId, modelId },
      );
    }
    return resolved;
  }

  listModels(): EmbeddingModelDescriptor[] {
    return Array.from(this.#providers.values()).flatMap((provider) => [...provider.models]);
  }
}
