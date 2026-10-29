import { readCredential } from "../credentials";
import { EmbeddingError } from "./errors";
import type {
  EmbeddingModelDescriptor,
  EmbeddingProvider,
  EmbeddingPurpose,
  ProviderEmbeddingOutput,
} from "./types";

const JINA_ENDPOINT = "https://api.jina.ai/v1/embeddings";

export const JINA_EMBEDDING_MODEL: EmbeddingModelDescriptor = {
  providerId: "jina",
  modelId: "jina-embeddings-v3",
  dimension: 1_024,
  maxInputChars: 8_000,
  maxBatchSize: 32,
  metric: "cosine",
  spaceVersion: "2024-09-v3-1024",
};

/**
 * Jina embeddings. Query and passage tasks use different task prefixes, which
 * materially improves retrieval; the vectors still belong to the same space
 * because they come from the same model and dimension.
 */
export class JinaEmbeddingProvider implements EmbeddingProvider {
  readonly id = "jina";
  readonly models = [JINA_EMBEDDING_MODEL] as const;
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
    return readCredential(this.#env, "JINA_API_KEY") !== undefined;
  }

  async embed(
    inputs: string[],
    model: EmbeddingModelDescriptor,
    options: { signal?: AbortSignal; correlationId: string; purpose?: EmbeddingPurpose },
  ): Promise<ProviderEmbeddingOutput> {
    const apiKey = readCredential(this.#env, "JINA_API_KEY");
    if (!apiKey) {
      throw new EmbeddingError(
        "provider_not_configured",
        "JINA_API_KEY is not configured on the server.",
        { providerId: this.id, modelId: model.modelId },
      );
    }

    const purpose = options.purpose ?? "document";
    let response: Response;
    try {
      response = await this.#fetch(JINA_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: model.modelId,
          input: inputs,
          dimensions: model.dimension,
          task: purpose === "query" ? "retrieval.query" : "retrieval.passage",
          normalized: true,
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
      throw new EmbeddingError(code, "The embedding provider rejected the request.", {
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
        {
          providerId: this.id,
          modelId: model.modelId,
        },
      );
    }
    if (typeof payload !== "object" || payload === null) {
      throw new EmbeddingError("invalid_response", "The embedding response was not an object.", {
        providerId: this.id,
        modelId: model.modelId,
      });
    }

    const rows = (payload as Record<string, unknown>)["data"];
    if (!Array.isArray(rows)) {
      throw new EmbeddingError("invalid_response", "The embedding response had no vectors.", {
        providerId: this.id,
        modelId: model.modelId,
      });
    }

    const vectors = rows
      .slice()
      .sort((a, b) => {
        const ai =
          typeof a === "object" && a !== null ? Number((a as Record<string, unknown>)["index"]) : 0;
        const bi =
          typeof b === "object" && b !== null ? Number((b as Record<string, unknown>)["index"]) : 0;
        return ai - bi;
      })
      .map((row) => {
        const embedding =
          typeof row === "object" && row !== null
            ? (row as Record<string, unknown>)["embedding"]
            : undefined;
        return Array.isArray(embedding)
          ? embedding.filter((v): v is number => typeof v === "number")
          : [];
      });

    const usage = (payload as Record<string, unknown>)["usage"];
    const tokens =
      typeof usage === "object" && usage !== null
        ? (usage as Record<string, unknown>)["total_tokens"]
        : undefined;

    return {
      vectors,
      ...(typeof tokens === "number" && Number.isFinite(tokens)
        ? { usage: { inputTokens: Math.round(tokens), source: "provider" as const } }
        : {}),
    };
  }
}
