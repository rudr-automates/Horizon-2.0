import { readCredential } from "../credentials";
import { EmbeddingError } from "./errors";
import type {
  EmbeddingModelDescriptor,
  EmbeddingProvider,
  EmbeddingPurpose,
  ProviderEmbeddingOutput,
} from "./types";

const ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents";

/**
 * Gemini's embedding model supports Matryoshka output sizes. 768 is the
 * dimension stored in `public.video_chunks`; changing either value requires a
 * new embedding space and a full reindex, because vectors are not comparable.
 */
export const GEMINI_EMBEDDING_MODEL: EmbeddingModelDescriptor = {
  providerId: "gemini",
  modelId: "gemini-embedding-001",
  dimension: 768,
  maxInputChars: 6_000,
  maxBatchSize: 32,
  metric: "cosine",
  spaceVersion: "2026-02-embedding-001-768",
};

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = "gemini";
  readonly models = [GEMINI_EMBEDDING_MODEL] as const;
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;

  constructor(
    env: Record<string, string | undefined> = process.env,
    fetcher: typeof fetch = fetch,
  ) {
    this.#env = env;
    this.#fetch = fetcher;
  }

  isConfigured(): boolean {
    return readCredential(this.#env, "GEMINI_API_KEY") !== undefined;
  }

  async embed(
    inputs: string[],
    model: EmbeddingModelDescriptor,
    options: { signal?: AbortSignal; correlationId: string; purpose?: EmbeddingPurpose },
  ): Promise<ProviderEmbeddingOutput> {
    const apiKey = readCredential(this.#env, "GEMINI_API_KEY");
    if (!apiKey) {
      throw new EmbeddingError(
        "provider_not_configured",
        "GEMINI_API_KEY is not configured on the server.",
        { providerId: this.id, modelId: model.modelId },
      );
    }

    const purpose = options.purpose ?? "document";
    let response: Response;
    try {
      response = await this.#fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requests: inputs.map((text) => ({
            model: `models/${model.modelId}`,
            content: { parts: [{ text }] },
            taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: model.dimension,
          })),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new EmbeddingError("aborted", "The embedding request was aborted.", {
          providerId: this.id,
          modelId: model.modelId,
          cause: error,
        });
      }
      throw new EmbeddingError("provider_unavailable", "Could not reach the embedding provider.", {
        providerId: this.id,
        modelId: model.modelId,
        cause: error,
      });
    }

    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs =
        retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : undefined;
      const code =
        response.status === 401 || response.status === 403
          ? "provider_not_configured"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "invalid_batch";
      let message = "The embedding provider rejected the request.";
      try {
        const payload = (await response.json()) as { error?: { message?: string } };
        if (payload.error?.message) message = payload.error.message.slice(0, 800);
      } catch {
        // The status code is enough; never log the key or request body.
      }
      throw new EmbeddingError(code, message, {
        providerId: this.id,
        modelId: model.modelId,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmbeddingError(
        "invalid_response",
        "The embedding provider returned malformed JSON.",
        { providerId: this.id, modelId: model.modelId },
      );
    }
    const embeddings =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["embeddings"]
        : undefined;
    if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
      throw new EmbeddingError("invalid_response", "The embedding response had no vectors.", {
        providerId: this.id,
        modelId: model.modelId,
      });
    }

    const vectors = embeddings.map((row) => {
      const values =
        typeof row === "object" && row !== null
          ? (row as Record<string, unknown>)["values"]
          : undefined;
      if (!Array.isArray(values)) {
        throw new EmbeddingError("invalid_response", "An embedding row had no vector.", {
          providerId: this.id,
          modelId: model.modelId,
        });
      }
      return values.filter((value): value is number => typeof value === "number");
    });

    return { vectors };
  }
}
