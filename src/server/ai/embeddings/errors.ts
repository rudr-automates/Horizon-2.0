export type EmbeddingErrorCode =
  | "invalid_batch"
  | "empty_input"
  | "input_too_large"
  | "batch_too_large"
  | "too_many_inputs"
  | "provider_not_configured"
  | "model_not_found"
  | "space_mismatch"
  | "dimension_mismatch"
  | "invalid_response"
  | "rate_limited"
  | "quota_exhausted"
  | "provider_unavailable"
  | "timeout"
  | "aborted"
  | "application_limit_exceeded";

export interface EmbeddingErrorOptions {
  providerId?: string;
  modelId?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: EmbeddingErrorCode, message: string, options: EmbeddingErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "EmbeddingError";
    this.code = code;
    this.providerId = options.providerId;
    this.modelId = options.modelId;
    this.retryAfterMs = options.retryAfterMs;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      providerId: this.providerId,
      modelId: this.modelId,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export function isEmbeddingError(error: unknown): error is EmbeddingError {
  return error instanceof EmbeddingError;
}
