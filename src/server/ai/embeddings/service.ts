import { EmbeddingError, isEmbeddingError } from "./errors";
import type { EmbeddingUsageGuard } from "./quota";
import type { EmbeddingProviderRegistry } from "./registry";
import { embeddingSpaceFor, validateEmbeddingSpace } from "./space";
import type {
  EmbeddingPurpose,
  EmbeddingResult,
  EmbeddingUsage,
  ProviderEmbeddingOutput,
} from "./types";
import {
  DEFAULT_EMBEDDING_LIMITS,
  validateEmbeddingInputs,
  validateEmbeddingVectors,
  type EmbeddingBatchLimits,
} from "./validation";

export interface EmbedRequest {
  providerId: string;
  modelId: string;
  inputs: string[];
  purpose?: EmbeddingPurpose;
  signal?: AbortSignal;
  correlationId?: string;
  timeoutMs?: number;
}

let embeddingCorrelationCounter = 1;

function correlationIdFor(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
  embeddingCorrelationCounter += 1;
  return `embed-${Date.now()}-${embeddingCorrelationCounter}`;
}

export class EmbeddingService {
  readonly #registry: EmbeddingProviderRegistry;
  readonly #limits: EmbeddingBatchLimits;
  readonly #guard: EmbeddingUsageGuard | undefined;
  readonly #now: () => number;

  constructor(
    registry: EmbeddingProviderRegistry,
    options: {
      limits?: EmbeddingBatchLimits;
      guard?: EmbeddingUsageGuard;
      now?: () => number;
    } = {},
  ) {
    this.#registry = registry;
    this.#limits = options.limits ?? DEFAULT_EMBEDDING_LIMITS;
    this.#guard = options.guard;
    this.#now = options.now ?? Date.now;
  }

  async embed(request: EmbedRequest): Promise<EmbeddingResult> {
    const { provider, model } = this.#registry.require(request.providerId, request.modelId);
    if (!provider.isConfigured()) {
      throw new EmbeddingError(
        "provider_not_configured",
        "The selected embedding provider is not configured on the server.",
        { providerId: provider.id, modelId: model.modelId },
      );
    }

    validateEmbeddingInputs(request.inputs, model, this.#limits);
    const chars = request.inputs.reduce((sum, input) => sum + input.length, 0);
    this.#guard?.checkAndRecord(request.inputs.length, chars);

    if (request.signal?.aborted) {
      throw new EmbeddingError("aborted", "The embedding request was cancelled.");
    }

    const correlationId = correlationIdFor(request.correlationId);
    const startedAt = this.#now();
    const timeoutMs = request.timeoutMs ?? 15_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new EmbeddingError("invalid_batch", "timeoutMs is outside the allowed range.");
    }

    const controller = new AbortController();
    const externalSignal = request.signal;
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new EmbeddingError("timeout", "The embedding provider did not respond in time.", {
            providerId: provider.id,
            modelId: model.modelId,
          }),
        );
      }, timeoutMs);
    });

    let output: ProviderEmbeddingOutput;
    try {
      output = await Promise.race([
        provider.embed(request.inputs, model, {
          signal: controller.signal,
          correlationId,
          ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
        }),
        timeout,
      ]);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new EmbeddingError("aborted", "The embedding request was cancelled.");
      }
      if (isEmbeddingError(error)) throw error;
      throw new EmbeddingError("provider_unavailable", "The embedding provider request failed.", {
        providerId: provider.id,
        modelId: model.modelId,
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }

    validateEmbeddingVectors(
      output.vectors,
      request.inputs.length,
      model.dimension,
      model.providerId,
      model.modelId,
    );

    const space = embeddingSpaceFor(model);
    validateEmbeddingSpace(space);
    return {
      vectors: output.vectors,
      space,
      usage: this.#usage(output.usage, chars),
      correlationId,
      latencyMs: this.#now() - startedAt,
    };
  }

  #usage(
    reported: { inputTokens?: number; source?: EmbeddingUsage["source"] } | undefined,
    chars: number,
  ): EmbeddingUsage {
    const tokens = reported?.inputTokens;
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
      return {
        inputTokens: Math.round(tokens),
        source: reported?.source === "estimated" ? "estimated" : "provider",
      };
    }
    return {
      inputTokens: Math.max(1, Math.ceil(chars / 4)),
      source: "estimated",
    };
  }
}
