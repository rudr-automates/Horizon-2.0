import { readCredential } from "../ai/credentials";

export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface Reranker {
  readonly id: string;
  isConfigured(): boolean;
  rerank(
    query: string,
    candidates: RerankCandidate[],
    options?: { topN?: number; signal?: AbortSignal },
  ): Promise<RerankResult[]>;
}

const JINA_RERANK_ENDPOINT = "https://api.jina.ai/v1/rerank";

/** Jina cross-encoder reranking over the fused candidate set. */
export class JinaReranker implements Reranker {
  readonly id = "jina-reranker";
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

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    options: { topN?: number; signal?: AbortSignal } = {},
  ): Promise<RerankResult[]> {
    const apiKey = readCredential(this.#env, "JINA_API_KEY");
    if (!apiKey || !candidates.length) return [];
    const documents = candidates.slice(0, 20);
    const response = await this.#fetch(JINA_RERANK_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "jina-reranker-v2-base-multilingual",
        query,
        documents: documents.map((candidate) => candidate.text),
        top_n: Math.min(options.topN ?? 8, documents.length),
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      throw new Error(`Reranker returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    const rows =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["results"]
        : undefined;
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        if (typeof row !== "object" || row === null) return undefined;
        const record = row as Record<string, unknown>;
        const index = record["index"];
        const score = record["relevance_score"];
        if (typeof index !== "number" || typeof score !== "number") return undefined;
        const candidate = documents[index];
        return candidate ? { id: candidate.id, score } : undefined;
      })
      .filter((row): row is RerankResult => row !== undefined);
  }
}
