import { AiError } from "./errors";
import type { GatewayConfig, GatewayModelConfig } from "./types";

/**
 * No model is enabled by default. Model ids and free-tier eligibility change
 * independently of this codebase, so deployment must opt in explicitly with
 * AI_MODEL_PREFERENCES after checking the provider's current terms.
 */
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  models: [],
  limits: {
    maxMessages: 50,
    maxTotalInputChars: 24_000,
    maxMessageChars: 12_000,
    maxOutputTokens: 1_024,
  },
  timeoutMs: 20_000,
  attemptsPerProvider: 2,
  totalAttempts: 4,
  backoff: { baseDelayMs: 250, maxDelayMs: 2_000, jitterRatio: 0.2 },
  maxInlineRetryDelayMs: 1_500,
  allowPaidModels: false,
};

export function validateGatewayConfig(config: GatewayConfig): void {
  if (config.allowPaidModels !== false) {
    throw new AiError(
      "invalid_configuration",
      "Paid model fallback is not permitted in this phase.",
    );
  }
  if (!Number.isInteger(config.attemptsPerProvider) || config.attemptsPerProvider < 1) {
    throw new AiError("invalid_configuration", "attemptsPerProvider must be at least 1.");
  }
  if (!Number.isInteger(config.totalAttempts) || config.totalAttempts < 1) {
    throw new AiError("invalid_configuration", "totalAttempts must be at least 1.");
  }
  if (config.timeoutMs < 100 || config.timeoutMs > 120_000) {
    throw new AiError("invalid_configuration", "timeoutMs must be between 100 and 120000.");
  }
  if (
    !Number.isInteger(config.limits.maxOutputTokens) ||
    config.limits.maxOutputTokens < 1 ||
    !Number.isInteger(config.limits.maxMessages) ||
    config.limits.maxMessages < 1 ||
    !Number.isInteger(config.limits.maxTotalInputChars) ||
    config.limits.maxTotalInputChars < 1 ||
    !Number.isInteger(config.limits.maxMessageChars) ||
    config.limits.maxMessageChars < 1 ||
    config.limits.maxMessageChars > config.limits.maxTotalInputChars
  ) {
    throw new AiError("invalid_configuration", "Input and output limits are invalid.");
  }
  if (
    !Number.isFinite(config.backoff.baseDelayMs) ||
    config.backoff.baseDelayMs < 0 ||
    !Number.isFinite(config.backoff.maxDelayMs) ||
    config.backoff.maxDelayMs < config.backoff.baseDelayMs ||
    !Number.isFinite(config.backoff.jitterRatio) ||
    config.backoff.jitterRatio < 0 ||
    config.backoff.jitterRatio > 1
  ) {
    throw new AiError("invalid_configuration", "Backoff settings are invalid.");
  }
  if (!Number.isFinite(config.maxInlineRetryDelayMs) || config.maxInlineRetryDelayMs < 0) {
    throw new AiError("invalid_configuration", "maxInlineRetryDelayMs is invalid.");
  }

  const seen = new Set<string>();
  for (const model of config.models) {
    const key = `${model.providerId}/${model.modelId}`;
    if (!model.providerId.trim() || !model.modelId.trim()) {
      throw new AiError(
        "invalid_configuration",
        "Every model entry needs a provider and model id.",
      );
    }
    if (seen.has(key)) {
      throw new AiError("invalid_configuration", `Duplicate model entry: ${key}`);
    }
    seen.add(key);
    if (model.maxInputChars !== undefined && model.maxInputChars < 1) {
      throw new AiError("invalid_configuration", `Model ${key} has an invalid input limit.`);
    }
    if (model.maxOutputTokens !== undefined && model.maxOutputTokens < 1) {
      throw new AiError("invalid_configuration", `Model ${key} has an invalid output limit.`);
    }
    if (model.tier !== "free") {
      throw new AiError(
        "invalid_configuration",
        `Model ${key} is not explicitly free-tier. Only free-tier models may be configured.`,
      );
    }
  }
}

/**
 * Reads model preferences from AI_MODEL_PREFERENCES. A missing value means no
 * provider is enabled. Malformed or paid entries fail closed instead of being
 * silently ignored.
 */
export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const raw = env["AI_MODEL_PREFERENCES"]?.trim();
  if (!raw) return { ...DEFAULT_GATEWAY_CONFIG, models: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError("invalid_configuration", "AI_MODEL_PREFERENCES must be valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new AiError(
      "invalid_configuration",
      "AI_MODEL_PREFERENCES must be a JSON array of model entries.",
    );
  }

  const models: GatewayModelConfig[] = parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new AiError(
        "invalid_configuration",
        `AI_MODEL_PREFERENCES[${index}] must be an object.`,
      );
    }
    const row = entry as Record<string, unknown>;
    const providerId = typeof row["providerId"] === "string" ? row["providerId"] : "";
    const modelId = typeof row["modelId"] === "string" ? row["modelId"] : "";
    const tier = row["tier"];
    if (!providerId.trim() || !modelId.trim()) {
      throw new AiError(
        "invalid_configuration",
        `AI_MODEL_PREFERENCES[${index}] needs providerId and modelId.`,
      );
    }
    if (tier !== "free") {
      throw new AiError(
        "invalid_configuration",
        `AI_MODEL_PREFERENCES[${index}] must declare tier "free".`,
      );
    }
    const maxInputChars =
      typeof row["maxInputChars"] === "number" ? row["maxInputChars"] : undefined;
    const maxOutputTokens =
      typeof row["maxOutputTokens"] === "number" ? row["maxOutputTokens"] : undefined;
    return {
      providerId,
      modelId,
      tier: "free" as const,
      enabled: row["enabled"] !== false,
      ...(maxInputChars === undefined ? {} : { maxInputChars }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };
  });

  const config: GatewayConfig = { ...DEFAULT_GATEWAY_CONFIG, models };
  validateGatewayConfig(config);
  return config;
}
