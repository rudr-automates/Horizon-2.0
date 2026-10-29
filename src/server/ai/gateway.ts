import { validateGatewayConfig } from "./config";
import { AiError, classifyProviderFailure, isAiError } from "./errors";
import { silentLogger, type AiLogger } from "./logging";
import type { AiRequest, GatewayConfig, GatewayModelConfig, TokenUsage } from "./types";
import { ProviderHealthTracker } from "./provider";
import { ProviderRegistry } from "./registry";
import { ConcurrencyGuard, QuotaLedger, estimateMessageTokens } from "./quota";
import type {
  AiCompletion,
  AiProvider,
  AttemptRecord,
  FinishReason,
  ProviderCall,
  ProviderOutput,
} from "./types";

const AUTH_FAILURE_COOLDOWN_MS = 15 * 60_000;
const QUOTA_FALLBACK_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_OUTPUT_TOKENS = 512;

export interface AiGatewayDeps {
  registry: ProviderRegistry;
  config: GatewayConfig;
  quota: QuotaLedger;
  logger?: AiLogger;
  health?: ProviderHealthTracker;
  concurrency?: ConcurrencyGuard;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  createCorrelationId?: () => string;
}

interface PreparedRequest {
  messages: AiRequest["messages"];
  inputChars: number;
  maxOutputTokens: number;
  temperature: number;
  responseFormat: "text" | "json";
  timeoutMs: number;
  correlationId: string;
  signal?: AbortSignal;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AiError("aborted", "The request was cancelled."));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiError("aborted", "The request was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let correlationCounter = 1;

function defaultCorrelationId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  correlationCounter += 1;
  return `ai-${Date.now()}-${correlationCounter}`;
}

export class AiGateway {
  readonly #registry: ProviderRegistry;
  readonly #config: GatewayConfig;
  readonly #quota: QuotaLedger;
  readonly #logger: AiLogger;
  readonly #health: ProviderHealthTracker;
  readonly #concurrency: ConcurrencyGuard;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #createCorrelationId: () => string;

  constructor(deps: AiGatewayDeps) {
    validateGatewayConfig(deps.config);
    this.#registry = deps.registry;
    this.#config = deps.config;
    this.#quota = deps.quota;
    this.#logger = deps.logger ?? silentLogger();
    this.#health = deps.health ?? new ProviderHealthTracker();
    this.#concurrency = deps.concurrency ?? new ConcurrencyGuard();
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? defaultSleep;
    this.#random = deps.random ?? Math.random;
    this.#createCorrelationId = deps.createCorrelationId ?? defaultCorrelationId;
  }

  async generate(request: AiRequest): Promise<AiCompletion> {
    const prepared = this.#prepare(request);
    const startedAt = this.#now();
    const candidates = this.#config.models.filter(
      (model) => model.enabled && model.tier === "free",
    );
    if (!candidates.length) {
      throw new AiError(
        "all_providers_unavailable",
        "No free-tier AI models are configured. Set AI_MODEL_PREFERENCES after reviewing provider terms.",
        { correlationId: prepared.correlationId },
      );
    }

    const globalLimit = this.#quota.globalConcurrencyLimit();
    const globalKey = "__global__";
    const globalAcquired = globalLimit !== undefined;
    if (globalAcquired && !this.#concurrency.tryAcquire(globalKey, globalLimit)) {
      throw new AiError(
        "application_limit_exceeded",
        "Too many AI requests are already in flight.",
        { correlationId: prepared.correlationId, fallbackAllowed: false },
      );
    }

    const attempts: AttemptRecord[] = [];
    let totalAttempts = 0;
    let firstAttemptKey: string | undefined;
    let skippedCandidate = false;

    try {
      for (const model of candidates) {
        const key = `${model.providerId}/${model.modelId}`;
        const provider = this.#registry.get(model.providerId);

        if (!provider) {
          skippedCandidate = true;
          attempts.push(this.#skip(model, "provider_not_configured"));
          this.#logSkip(prepared, model, "provider_not_configured");
          continue;
        }
        if (!provider.isConfigured()) {
          skippedCandidate = true;
          attempts.push(this.#skip(model, "missing_credentials"));
          this.#logSkip(prepared, model, "missing_credentials");
          continue;
        }
        if (!this.#health.isAvailable(provider.id, this.#now())) {
          skippedCandidate = true;
          attempts.push(this.#skip(model, "provider_unavailable"));
          this.#logSkip(prepared, model, "provider_unavailable");
          continue;
        }

        const modelLimit = model.maxInputChars ?? this.#config.limits.maxTotalInputChars;
        if (prepared.inputChars > modelLimit) {
          skippedCandidate = true;
          attempts.push(this.#skip(model, "invalid_request"));
          this.#logSkip(prepared, model, "invalid_request");
          continue;
        }

        const providerConcurrency = this.#quota.concurrencyLimit(provider.id, model.modelId) ?? 1;
        if (!this.#concurrency.tryAcquire(key, providerConcurrency)) {
          skippedCandidate = true;
          attempts.push(this.#skip(model, "provider_unavailable"));
          this.#logSkip(prepared, model, "provider_unavailable");
          continue;
        }

        try {
          const estimatedTokens = estimateMessageTokens(prepared.messages);
          const effectiveMaxOutput = Math.min(
            prepared.maxOutputTokens,
            model.maxOutputTokens ?? this.#config.limits.maxOutputTokens,
          );

          for (
            let attempt = 1;
            attempt <= this.#config.attemptsPerProvider &&
            totalAttempts < this.#config.totalAttempts;
            attempt += 1
          ) {
            // Reserve per upstream attempt, not per learner request: a retry is
            // still a provider call and must consume the provider's budget.
            const decision = this.#quota.checkAndReserve({
              providerId: provider.id,
              modelId: model.modelId,
              estimatedTokens,
            });
            if (!decision.allowed) {
              if (decision.global) throw decision.error;
              skippedCandidate = true;
              attempts.push(this.#skip(model, decision.error.code));
              this.#logSkip(prepared, model, decision.error.code);
              break;
            }

            const reservation = decision.reservation;
            totalAttempts += 1;
            firstAttemptKey ??= key;
            const attemptStarted = this.#now();
            try {
              const output = await this.#callProvider(
                provider,
                model,
                prepared,
                effectiveMaxOutput,
              );
              const normalized = this.#normalizeOutput(output, provider.id, model.modelId);
              const usage = this.#normalizeUsage(normalized);
              this.#quota.settle(reservation, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
              this.#health.markHealthy(provider.id);
              this.#quota.markProviderAvailable(provider.id, model.modelId);

              const durationMs = this.#now() - attemptStarted;
              attempts.push({
                providerId: provider.id,
                modelId: model.modelId,
                attempt,
                outcome: "success",
                durationMs,
              });
              this.#logger.info("ai.completion", {
                correlationId: prepared.correlationId,
                providerId: provider.id,
                modelId: model.modelId,
                attempt,
                durationMs,
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
                inputChars: prepared.inputChars,
              });

              return {
                text: normalized.text,
                providerId: provider.id,
                modelId: model.modelId,
                usage,
                finishReason: this.#normalizeFinishReason(normalized.finishReason),
                correlationId: prepared.correlationId,
                latencyMs: this.#now() - startedAt,
                attempts,
                fallbackUsed: skippedCandidate || firstAttemptKey !== key,
              };
            } catch (error) {
              const failure = this.#classify(error, provider, model);
              const durationMs = this.#now() - attemptStarted;
              attempts.push({
                providerId: provider.id,
                modelId: model.modelId,
                attempt,
                outcome: "error",
                errorCode: failure.code,
                durationMs,
              });
              this.#quota.settle(reservation, 0);
              this.#logger.warn("ai.provider_error", {
                correlationId: prepared.correlationId,
                providerId: provider.id,
                modelId: model.modelId,
                attempt,
                errorCode: failure.code,
                durationMs,
              });

              if (failure.code === "rate_limited") {
                const waitMs = failure.retryAfterMs ?? this.#backoff(attempt);
                this.#quota.markRateLimited(provider.id, waitMs);
                if (
                  failure.retryAfterMs !== undefined &&
                  failure.retryAfterMs > this.#config.maxInlineRetryDelayMs
                ) {
                  break;
                }
                if (
                  attempt < this.#config.attemptsPerProvider &&
                  totalAttempts < this.#config.totalAttempts
                ) {
                  await this.#sleep(this.#retryDelay(failure, attempt), prepared.signal);
                  continue;
                }
                break;
              }

              if (failure.code === "quota_exhausted") {
                this.#quota.markProviderExhausted(
                  provider.id,
                  model.modelId,
                  failure.quotaResetAt ?? this.#now() + QUOTA_FALLBACK_COOLDOWN_MS,
                );
                break;
              }

              if (failure.code === "authentication_failed") {
                this.#health.markUnhealthy(
                  provider.id,
                  AUTH_FAILURE_COOLDOWN_MS,
                  this.#now(),
                  "authentication_failed",
                );
                break;
              }

              if (this.#mustStop(failure)) throw failure;

              if (
                failure.retryable &&
                attempt < this.#config.attemptsPerProvider &&
                totalAttempts < this.#config.totalAttempts
              ) {
                await this.#sleep(this.#backoff(attempt), prepared.signal);
                continue;
              }

              if (!failure.fallbackAllowed) throw failure;
              break;
            }
          }
        } finally {
          this.#concurrency.release(key);
        }
      }
    } finally {
      if (globalAcquired) this.#concurrency.release(globalKey);
    }

    throw new AiError(
      "all_providers_unavailable",
      "No configured free-tier AI provider could complete the request. No paid provider was tried.",
      { correlationId: prepared.correlationId },
    );
  }

  #prepare(request: AiRequest): PreparedRequest {
    if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
      throw new AiError("invalid_request", "At least one message is required.");
    }
    if (request.messages.length > this.#config.limits.maxMessages) {
      throw new AiError("invalid_request", "Too many messages were supplied.");
    }

    let inputChars = 0;
    for (const message of request.messages) {
      if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
        throw new AiError("invalid_request", "A message has an unsupported role.");
      }
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw new AiError("invalid_request", "Message content must be non-empty text.");
      }
      if (message.content.length > this.#config.limits.maxMessageChars) {
        throw new AiError("invalid_request", "A message exceeds the per-message size limit.");
      }
      inputChars += message.content.length;
    }
    if (inputChars > this.#config.limits.maxTotalInputChars) {
      throw new AiError("invalid_request", "The request exceeds the input size limit.");
    }

    const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    if (
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > this.#config.limits.maxOutputTokens
    ) {
      throw new AiError("invalid_request", "maxOutputTokens is outside the allowed range.");
    }

    const temperature = request.temperature ?? DEFAULT_TEMPERATURE;
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new AiError("invalid_request", "temperature must be between 0 and 2.");
    }

    const timeoutMs = request.timeoutMs ?? this.#config.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
      throw new AiError("invalid_request", "timeoutMs is outside the allowed range.");
    }

    if (request.signal?.aborted) {
      throw new AiError("aborted", "The request was cancelled.");
    }

    return {
      messages: request.messages,
      inputChars,
      maxOutputTokens,
      temperature,
      responseFormat: request.responseFormat === "json" ? "json" : "text",
      timeoutMs,
      correlationId: this.#safeCorrelationId(request.correlationId),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
  }

  #safeCorrelationId(value: string | undefined): string {
    const trimmed = value?.trim();
    if (!trimmed) return this.#createCorrelationId();
    return trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
  }

  async #callProvider(
    provider: AiProvider,
    model: GatewayModelConfig,
    prepared: PreparedRequest,
    maxOutputTokens: number,
  ): Promise<ProviderOutput> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const externalSignal = prepared.signal;
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AiError("timeout", "The provider did not respond before the deadline.", {
            providerId: provider.id,
            modelId: model.modelId,
            correlationId: prepared.correlationId,
          }),
        );
      }, prepared.timeoutMs);
    });

    const call: ProviderCall = {
      modelId: model.modelId,
      messages: prepared.messages,
      maxOutputTokens,
      temperature: prepared.temperature,
      responseFormat: prepared.responseFormat,
      signal: controller.signal,
      correlationId: prepared.correlationId,
    };

    try {
      return await Promise.race([provider.complete(call), timeout]);
    } catch (error) {
      if (externalSignal?.aborted) {
        throw new AiError("aborted", "The request was cancelled.", {
          providerId: provider.id,
          modelId: model.modelId,
          correlationId: prepared.correlationId,
        });
      }
      if (isAiError(error)) throw error;
      throw classifyProviderFailure(error, {
        providerId: provider.id,
        modelId: model.modelId,
        correlationId: prepared.correlationId,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }

  #normalizeOutput(output: ProviderOutput, providerId: string, modelId: string): ProviderOutput {
    if (
      typeof output !== "object" ||
      output === null ||
      typeof output.text !== "string" ||
      !output.text.trim()
    ) {
      throw new AiError("response_invalid", "The provider returned an unusable response.", {
        providerId,
        modelId,
        fallbackAllowed: true,
      });
    }
    return output;
  }

  #normalizeUsage(output: ProviderOutput): TokenUsage {
    const input = this.#tokenCount(output.usage?.inputTokens);
    const generated = this.#tokenCount(output.usage?.outputTokens);
    const reportedSource = output.usage?.source;

    if (input === undefined && generated === undefined) {
      return { source: "unknown" };
    }
    return {
      ...(input === undefined ? {} : { inputTokens: input }),
      ...(generated === undefined ? {} : { outputTokens: generated }),
      source:
        reportedSource === "estimated"
          ? "estimated"
          : input !== undefined && generated !== undefined
            ? "provider"
            : "estimated",
    };
  }

  #tokenCount(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : undefined;
  }

  #normalizeFinishReason(value: FinishReason | undefined): FinishReason {
    return value === "stop" || value === "length" || value === "refusal" ? value : "unknown";
  }

  #classify(error: unknown, provider: AiProvider, model: GatewayModelConfig): AiError {
    if (isAiError(error)) return error;
    return classifyProviderFailure(error, {
      providerId: provider.id,
      modelId: model.modelId,
    });
  }

  #mustStop(error: AiError): boolean {
    return (
      error.code === "invalid_request" ||
      error.code === "invalid_configuration" ||
      error.code === "content_refused" ||
      error.code === "aborted" ||
      error.code === "timeout" ||
      (error.code === "application_limit_exceeded" && !error.fallbackAllowed)
    );
  }

  #skip(model: GatewayModelConfig, code: AttemptRecord["errorCode"]): AttemptRecord {
    return {
      providerId: model.providerId,
      modelId: model.modelId,
      attempt: 0,
      outcome: "skipped",
      ...(code === undefined ? {} : { errorCode: code }),
      durationMs: 0,
    };
  }

  #backoff(attempt: number): number {
    const exponential = this.#config.backoff.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    const capped = Math.min(this.#config.backoff.maxDelayMs, exponential);
    const jitter = capped * this.#config.backoff.jitterRatio * (this.#random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }

  #retryDelay(error: AiError, attempt: number): number {
    return Math.min(
      error.retryAfterMs ?? this.#backoff(attempt),
      this.#config.maxInlineRetryDelayMs,
    );
  }

  #logSkip(prepared: PreparedRequest, model: GatewayModelConfig, reason: string): void {
    this.#logger.info("ai.candidate_skipped", {
      correlationId: prepared.correlationId,
      providerId: model.providerId,
      modelId: model.modelId,
      reason,
    });
  }
}
