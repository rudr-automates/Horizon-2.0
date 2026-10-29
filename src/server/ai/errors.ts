import type { AiErrorCode } from "./types";

export interface AiErrorOptions {
  providerId?: string;
  modelId?: string;
  retryAfterMs?: number;
  quotaResetAt?: number;
  httpStatus?: number;
  correlationId?: string;
  retryable?: boolean;
  fallbackAllowed?: boolean;
  cause?: unknown;
}

/** Failures that may be resolved by repeating the request after a delay. */
const RETRYABLE_CODES = new Set<AiErrorCode>([
  "rate_limited",
  "network_error",
  "provider_unavailable",
]);

/**
 * Failures where another configured provider may plausibly succeed. Invalid
 * input, refusals, timeouts and application spending guards deliberately do not
 * fall back: repeating them can duplicate work or bypass a safety decision.
 */
const FALLBACK_CODES = new Set<AiErrorCode>([
  "rate_limited",
  "quota_exhausted",
  "network_error",
  "provider_unavailable",
  "provider_not_configured",
  "missing_credentials",
  "authentication_failed",
  "unsupported_model",
  "response_invalid",
]);

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly quotaResetAt: number | undefined;
  readonly httpStatus: number | undefined;
  readonly correlationId: string | undefined;
  readonly retryable: boolean;
  readonly fallbackAllowed: boolean;

  constructor(code: AiErrorCode, message: string, options: AiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiError";
    this.code = code;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.retryAfterMs = options.retryAfterMs;
    this.quotaResetAt = options.quotaResetAt;
    this.httpStatus = options.httpStatus;
    this.correlationId = options.correlationId;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.fallbackAllowed = options.fallbackAllowed ?? FALLBACK_CODES.has(code);
  }

  /** Serializable shape for logs and API responses. Never includes raw bodies. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      providerId: this.providerId,
      modelId: this.modelId,
      retryAfterMs: this.retryAfterMs,
      quotaResetAt: this.quotaResetAt,
      httpStatus: this.httpStatus,
      correlationId: this.correlationId,
      retryable: this.retryable,
      fallbackAllowed: this.fallbackAllowed,
    };
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

/**
 * Maps an HTTP status to an error classification. Provider adapters should use
 * this and may refine rate-limit responses with Retry-After / quota metadata.
 * Response bodies are deliberately not inspected here: they may contain learner
 * content or provider-specific, unstable text.
 */
export function classifyHttpStatus(
  status: number,
  options: Omit<AiErrorOptions, "httpStatus"> = {},
): AiError {
  const common = { ...options, httpStatus: status };

  if (status === 400 || status === 422) {
    return new AiError("invalid_request", "The provider rejected the request.", common);
  }
  if (status === 401 || status === 403) {
    return new AiError(
      "authentication_failed",
      "The provider rejected the configured credentials.",
      common,
    );
  }
  if (status === 404) {
    return new AiError("unsupported_model", "The configured model was not found.", common);
  }
  if (status === 408) {
    return new AiError("timeout", "The provider reported a timeout.", common);
  }
  if (status === 429) {
    return new AiError("rate_limited", "The provider rate limit was reached.", common);
  }
  if (status >= 500) {
    return new AiError("provider_unavailable", "The provider is unavailable.", common);
  }
  return new AiError("provider_unavailable", "The provider request failed.", common);
}

/** Converts arbitrary adapter failures into a sanitized, classified AiError. */
export function classifyProviderFailure(error: unknown, options: AiErrorOptions = {}): AiError {
  if (isAiError(error)) return error;

  if (error instanceof Error && error.name === "AbortError") {
    return new AiError("aborted", "The provider request was aborted.", options);
  }
  return new AiError(
    "network_error",
    "The provider request failed before a usable response arrived.",
    { ...options, cause: error },
  );
}
