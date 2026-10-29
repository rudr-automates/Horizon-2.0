/** Shared, provider-neutral AI contracts. No provider SDK types leak in here. */

export type AiProviderId = string;
export type ModelTier = "free" | "paid";

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export type AiErrorCode =
  | "invalid_request"
  | "invalid_configuration"
  | "missing_credentials"
  | "provider_not_configured"
  | "authentication_failed"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "aborted"
  | "network_error"
  | "provider_unavailable"
  | "unsupported_model"
  | "content_refused"
  | "response_invalid"
  | "application_limit_exceeded"
  | "all_providers_unavailable";

export type FinishReason = "stop" | "length" | "refusal" | "unknown";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Where the numbers came from. Providers do not always report usage. */
  source: "provider" | "estimated" | "unknown";
}

export interface AiRequest {
  messages: AiMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask providers that support it for a JSON object response. */
  responseFormat?: "text" | "json";
  /** Caller-generated idempotency/correlation value. Generated when omitted. */
  correlationId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderCall {
  modelId: string;
  messages: AiMessage[];
  maxOutputTokens: number;
  temperature: number;
  responseFormat: "text" | "json";
  signal: AbortSignal;
  correlationId: string;
}

export interface ProviderOutput {
  text: string;
  usage?: Partial<Omit<TokenUsage, "source">> & { source?: TokenUsage["source"] };
  finishReason?: FinishReason;
  /** Provider-specific safe metadata. Never include secrets or learner content. */
  metadata?: Record<string, string | number | boolean>;
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unknown";
  checkedAt: number;
  /** Short, non-sensitive explanation suitable for logs. */
  detail?: string;
}

/**
 * A provider adapter. Implementations are registered on the server only and
 * must never be imported into a browser bundle.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  /** False when the server environment lacks this provider's credentials. */
  isConfigured(): boolean;
  complete(call: ProviderCall): Promise<ProviderOutput>;
  health?(): Promise<ProviderHealth>;
}

export interface ModelCapabilities {
  text: true;
  streaming: boolean;
  structuredOutput: boolean;
}

export interface GatewayModelConfig {
  providerId: AiProviderId;
  modelId: string;
  tier: ModelTier;
  enabled: boolean;
  maxInputChars?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  notes?: string;
}

export interface GatewayLimits {
  maxMessages: number;
  maxTotalInputChars: number;
  maxMessageChars: number;
  maxOutputTokens: number;
}

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export interface GatewayConfig {
  /** Ordered preference list. Only entries explicitly marked free are eligible. */
  models: GatewayModelConfig[];
  limits: GatewayLimits;
  timeoutMs: number;
  /** Attempts per candidate provider, including the first one. */
  attemptsPerProvider: number;
  /** Hard cap across every provider for one user request. */
  totalAttempts: number;
  backoff: BackoffConfig;
  /** Longest provider-requested wait we will hold a request for. */
  maxInlineRetryDelayMs: number;
  /** Paid models must remain disabled until a human opts in explicitly. */
  allowPaidModels: false;
}

export interface AttemptRecord {
  providerId: string;
  modelId: string;
  attempt: number;
  outcome: "success" | "error" | "skipped";
  errorCode?: AiErrorCode;
  durationMs: number;
}

export interface AiCompletion {
  text: string;
  providerId: string;
  modelId: string;
  usage: TokenUsage;
  finishReason: FinishReason;
  correlationId: string;
  latencyMs: number;
  attempts: AttemptRecord[];
  fallbackUsed: boolean;
}

export interface CandidateSkip {
  providerId: string;
  modelId: string;
  reason: AiErrorCode;
}
