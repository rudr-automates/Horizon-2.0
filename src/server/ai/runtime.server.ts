import { loadGatewayConfig, validateGatewayConfig } from "./config";
import { credentialStatus } from "./credentials";
import { EmbeddingService } from "./embeddings/service";
import { GeminiEmbeddingProvider } from "./embeddings/gemini";
import { JinaEmbeddingProvider, JINA_EMBEDDING_MODEL } from "./embeddings/jina";
import { EmbeddingUsageGuard } from "./embeddings/quota";
import { EmbeddingProviderRegistry } from "./embeddings/registry";
import { JinaReranker } from "../retrieval/rerank";
import { AiGateway } from "./gateway";
import { createAiLogger } from "./logging";
import { GeminiProvider } from "./providers/gemini";
import { GroqProvider } from "./providers/groq";
import { ProviderRegistry } from "./registry";
import type { GatewayConfig, GatewayModelConfig } from "./types";
import { QuotaLedger, type QuotaPolicy } from "./quota";

/**
 * These are current free-tier candidates verified against the configured
 * account during Phase 2. They are not permanent truths: AI_MODEL_PREFERENCES
 * overrides them, and a retired model fails closed rather than silently
 * selecting a paid replacement.
 */
const DEFAULT_FREE_MODELS: GatewayModelConfig[] = [
  {
    providerId: "gemini",
    modelId: "gemini-3.5-flash-lite",
    tier: "free",
    enabled: true,
    maxInputChars: 14_000,
    // Exam-sized JSON answers (six questions with explanations) need more than
    // a 900-token ceiling: a truncated body fails verification every time.
    maxOutputTokens: 3_072,
    notes: "Primary free-tier candidate; verify current Google AI Studio terms.",
  },
  {
    providerId: "groq",
    modelId: "openai/gpt-oss-20b",
    tier: "free",
    enabled: true,
    maxInputChars: 14_000,
    maxOutputTokens: 3_072,
    notes: "Free-tier fallback; reasoning tokens are bounded by max_completion_tokens.",
  },
];

function buildConfig(env: Record<string, string | undefined>): GatewayConfig {
  const explicit = env["AI_MODEL_PREFERENCES"]?.trim();
  const base = loadGatewayConfig(env);
  const models = explicit ? base.models : DEFAULT_FREE_MODELS;
  const config: GatewayConfig = {
    ...base,
    models,
    limits: { ...base.limits, maxOutputTokens: 3_072 },
    timeoutMs: 45_000,
    attemptsPerProvider: 2,
    totalAttempts: 3,
    maxInlineRetryDelayMs: 1_500,
  };
  validateGatewayConfig(config);
  return config;
}

function buildQuota(models: GatewayModelConfig[]): QuotaLedger {
  const policies: QuotaPolicy[] = models.map((model) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    application: {
      perMinute: { requests: 8, tokens: 60_000 },
      perDay: { requests: 150, tokens: 250_000 },
      concurrency: 1,
    },
  }));
  return new QuotaLedger(policies, {
    perMinute: { requests: 12 },
    perDay: { requests: 250 },
    concurrency: 2,
  });
}

export interface AiRuntime {
  gateway: AiGateway;
  embeddings: EmbeddingService;
  embeddingRegistry: EmbeddingProviderRegistry;
  reranker: JinaReranker;
  config: GatewayConfig;
  quota: QuotaLedger;
}

let runtime: AiRuntime | undefined;

export function getAiRuntime(env: Record<string, string | undefined> = process.env): AiRuntime {
  if (runtime) return runtime;
  const config = buildConfig(env);
  const registry = new ProviderRegistry()
    .register(new GeminiProvider(env))
    .register(new GroqProvider(env));
  const quota = buildQuota(config.models);
  const gateway = new AiGateway({
    registry,
    config,
    quota,
    logger: createAiLogger(),
  });

  const embeddingRegistry = new EmbeddingProviderRegistry()
    .register(new JinaEmbeddingProvider(env))
    .register(new GeminiEmbeddingProvider(env));
  const embeddings = new EmbeddingService(embeddingRegistry, {
    guard: new EmbeddingUsageGuard({
      requestsPerMinute: 10,
      inputsPerDay: 4_000,
      charsPerDay: 3_000_000,
    }),
  });

  runtime = {
    gateway,
    embeddings,
    embeddingRegistry,
    reranker: new JinaReranker(env),
    config,
    quota,
  };
  return runtime;
}

/** Safe, non-secret setup information for the authenticated UI. */
export function getAiProviderStatus(env: Record<string, string | undefined> = process.env) {
  const config = buildConfig(env);
  return {
    providers: ["gemini", "groq"].map((providerId) => {
      const status = credentialStatus(env, providerId);
      return {
        providerId,
        configured: status.configured,
        models: config.models
          .filter((model) => model.providerId === providerId)
          .map((model) => model.modelId),
      };
    }),
    embeddings: {
      providerId: JINA_EMBEDDING_MODEL.providerId,
      modelId: JINA_EMBEDDING_MODEL.modelId,
      dimension: JINA_EMBEDDING_MODEL.dimension,
      configured: credentialStatus(env, "jina").configured,
    },
    paidFallback: false as const,
  };
}
