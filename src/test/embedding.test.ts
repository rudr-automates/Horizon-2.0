import { describe, expect, it } from "vitest";
import { EmbeddingError } from "@/server/ai/embeddings/errors";
import { MockEmbeddingProvider } from "@/server/ai/embeddings/mock-provider";
import { EmbeddingUsageGuard } from "@/server/ai/embeddings/quota";
import { EmbeddingProviderRegistry } from "@/server/ai/embeddings/registry";
import { chooseRetrievalMode } from "@/server/ai/embeddings/retrieval-mode";
import { EmbeddingService } from "@/server/ai/embeddings/service";
import {
  assertCompatibleSpace,
  embeddingSpaceFor,
  embeddingSpaceKey,
  isCompatibleSpace,
} from "@/server/ai/embeddings/space";
import { validateEmbeddingInputs } from "@/server/ai/embeddings/validation";
import type {
  EmbeddingIndexMetadata,
  EmbeddingModelDescriptor,
  EmbeddingProvider,
} from "@/server/ai/embeddings/types";

const MODEL_ID = "mock-embedding-model";

function registryWith(provider: EmbeddingProvider): EmbeddingProviderRegistry {
  return new EmbeddingProviderRegistry().register(provider);
}

function descriptor(overrides: Partial<EmbeddingModelDescriptor> = {}): EmbeddingModelDescriptor {
  return {
    providerId: "mock-embed",
    modelId: MODEL_ID,
    dimension: 8,
    maxInputChars: 8_000,
    maxBatchSize: 32,
    metric: "cosine",
    spaceVersion: "v1",
    ...overrides,
  };
}

describe("embedding service", () => {
  it("returns deterministic vectors with explicit space metadata", async () => {
    const provider = new MockEmbeddingProvider();
    const service = new EmbeddingService(registryWith(provider));

    const first = await service.embed({
      providerId: provider.id,
      modelId: MODEL_ID,
      inputs: ["An embedding represents meaning.", "Cosine similarity compares direction."],
    });
    const second = await service.embed({
      providerId: provider.id,
      modelId: MODEL_ID,
      inputs: ["An embedding represents meaning.", "Cosine similarity compares direction."],
    });

    expect(first.vectors).toEqual(second.vectors);
    expect(first.vectors).toHaveLength(2);
    expect(first.vectors.every((vector) => vector.length === 8)).toBe(true);
    expect(first.space).toEqual({
      providerId: "mock-embed",
      modelId: MODEL_ID,
      dimension: 8,
      version: "v1",
    });
    expect(first.usage).toEqual({ inputTokens: expect.any(Number), source: "estimated" });
  });

  it("rejects an empty or oversized batch before calling the provider", async () => {
    const provider = new MockEmbeddingProvider();
    const service = new EmbeddingService(registryWith(provider));

    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: [] }),
    ).rejects.toMatchObject({ code: "invalid_batch" });
    await expect(
      service.embed({
        providerId: provider.id,
        modelId: MODEL_ID,
        inputs: Array.from({ length: 33 }, (_, index) => `chunk ${index}`),
      }),
    ).rejects.toMatchObject({ code: "too_many_inputs" });
    await expect(
      service.embed({
        providerId: provider.id,
        modelId: MODEL_ID,
        inputs: ["x".repeat(8_001)],
      }),
    ).rejects.toMatchObject({ code: "input_too_large" });
    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: ["   "] }),
    ).rejects.toMatchObject({ code: "empty_input" });

    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a total batch that exceeds the character budget without truncation", async () => {
    const provider = new MockEmbeddingProvider();
    const service = new EmbeddingService(registryWith(provider), {
      limits: { maxBatchSize: 32, maxInputChars: 8_000, maxTotalChars: 20 },
    });

    await expect(
      service.embed({
        providerId: provider.id,
        modelId: MODEL_ID,
        inputs: ["fifteen chars!!", "another fifteen!"],
      }),
    ).rejects.toMatchObject({ code: "batch_too_large" });
    expect(provider.calls).toHaveLength(0);
  });

  it("fails closed when the provider is not configured", async () => {
    const provider = new MockEmbeddingProvider({ configured: false });
    const service = new EmbeddingService(registryWith(provider));

    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: ["text"] }),
    ).rejects.toMatchObject({ code: "provider_not_configured" });
    expect(provider.calls).toHaveLength(0);
  });

  it("reports an unknown model without guessing a provider", async () => {
    const service = new EmbeddingService(registryWith(new MockEmbeddingProvider()));
    await expect(
      service.embed({ providerId: "mock-embed", modelId: "nope", inputs: ["text"] }),
    ).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("rejects vectors with the wrong dimension or non-finite values", async () => {
    const wrongDimension: EmbeddingProvider = {
      id: "bad",
      models: [descriptor({ providerId: "bad", dimension: 8 })],
      isConfigured: () => true,
      embed: async () => ({ vectors: [[1, 0, 0]] }),
    };
    const badValues: EmbeddingProvider = {
      id: "bad-values",
      models: [descriptor({ providerId: "bad-values", dimension: 2 })],
      isConfigured: () => true,
      embed: async () => ({ vectors: [[Number.NaN, 1]] }),
    };

    await expect(
      new EmbeddingService(registryWith(wrongDimension)).embed({
        providerId: "bad",
        modelId: MODEL_ID,
        inputs: ["text"],
      }),
    ).rejects.toMatchObject({ code: "dimension_mismatch" });

    await expect(
      new EmbeddingService(registryWith(badValues)).embed({
        providerId: "bad-values",
        modelId: MODEL_ID,
        inputs: ["text"],
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("times out a hanging provider without accepting partial results", async () => {
    const provider = new MockEmbeddingProvider().hangNext();
    const service = new EmbeddingService(registryWith(provider));

    await expect(
      service.embed({
        providerId: provider.id,
        modelId: MODEL_ID,
        inputs: ["text"],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("passes through provider rate-limit classification", async () => {
    const provider = new MockEmbeddingProvider().failNext(
      new EmbeddingError("rate_limited", "slow down", { retryAfterMs: 5_000 }),
    );
    const service = new EmbeddingService(registryWith(provider));

    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: ["text"] }),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 5_000 });
  });

  it("enforces an application-level request guard", async () => {
    const provider = new MockEmbeddingProvider();
    const guard = new EmbeddingUsageGuard({ requestsPerMinute: 1 }, () => 1_000_000);
    const service = new EmbeddingService(registryWith(provider), { guard });

    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: ["one"] }),
    ).resolves.toBeDefined();
    await expect(
      service.embed({ providerId: provider.id, modelId: MODEL_ID, inputs: ["two"] }),
    ).rejects.toMatchObject({ code: "application_limit_exceeded" });
  });

  it("rejects duplicate or malformed model registrations", () => {
    const registry = new EmbeddingProviderRegistry().register(new MockEmbeddingProvider());
    expect(() => registry.register(new MockEmbeddingProvider())).toThrow();

    const mismatchedProvider: EmbeddingProvider = {
      id: "different-id",
      models: [descriptor({ providerId: "mismatch" })],
      isConfigured: () => true,
      embed: async () => ({ vectors: [] }),
    };
    expect(() => new EmbeddingProviderRegistry().register(mismatchedProvider)).toThrow();
  });

  it("uses the model-declared batch and character limits directly", () => {
    expect(() => validateEmbeddingInputs(["text"], descriptor({ maxInputChars: 3 }))).toThrow(
      EmbeddingError,
    );
  });
});

describe("embedding spaces", () => {
  it("treats model, dimension and version changes as different spaces", () => {
    const base = embeddingSpaceFor(descriptor());
    expect(isCompatibleSpace(base, embeddingSpaceFor(descriptor()))).toBe(true);
    expect(isCompatibleSpace(base, embeddingSpaceFor(descriptor({ dimension: 16 })))).toBe(false);
    expect(isCompatibleSpace(base, embeddingSpaceFor(descriptor({ spaceVersion: "v2" })))).toBe(
      false,
    );
    expect(isCompatibleSpace(base, embeddingSpaceFor(descriptor({ modelId: "other-model" })))).toBe(
      false,
    );

    const keys = new Set([
      embeddingSpaceKey(base),
      embeddingSpaceKey(embeddingSpaceFor(descriptor({ dimension: 16 }))),
      embeddingSpaceKey(embeddingSpaceFor(descriptor({ spaceVersion: "v2" }))),
      embeddingSpaceKey(embeddingSpaceFor(descriptor({ modelId: "other-model" }))),
    ]);
    expect(keys.size).toBe(4);
    expect(() =>
      assertCompatibleSpace(base, embeddingSpaceFor(descriptor({ spaceVersion: "v2" }))),
    ).toThrow(EmbeddingError);
  });

  it("falls back to keyword retrieval when no compatible ready index exists", () => {
    const space = embeddingSpaceFor(descriptor());
    const index = (
      status: EmbeddingIndexMetadata["status"],
      indexSpace = space,
    ): EmbeddingIndexMetadata => ({
      indexId: "index-1",
      space: indexSpace,
      status,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(chooseRetrievalMode(null, space)).toEqual({ mode: "keyword", reason: "no_index" });
    expect(chooseRetrievalMode(index("stale"), space)).toEqual({
      mode: "keyword",
      reason: "index_not_ready",
    });
    expect(chooseRetrievalMode(index("ready"), null)).toEqual({
      mode: "keyword",
      reason: "no_query_embedding_space",
    });
    expect(
      chooseRetrievalMode(index("ready"), embeddingSpaceFor(descriptor({ dimension: 16 }))),
    ).toEqual({ mode: "keyword", reason: "space_mismatch" });
    expect(chooseRetrievalMode(index("ready"), space)).toEqual({
      mode: "semantic",
      reason: "compatible_index",
    });
  });
});
