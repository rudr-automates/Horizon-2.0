import { AiError } from "../errors";

export interface ProviderRequestContext {
  providerId: string;
  modelId: string;
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1_000)) : undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - Date.now());
}

function providerCodeFromBody(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as Record<string, unknown>)["error"];
    if (typeof error === "string") return error.slice(0, 160);
    if (typeof error !== "object" || error === null) return undefined;
    const row = error as Record<string, unknown>;
    for (const key of ["code", "type", "status"]) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
    }
  } catch {
    // Error bodies are diagnostic only. Never surface them to a learner.
  }
  return undefined;
}

/**
 * Converts an unsuccessful provider response into a typed error without
 * retaining the response body. Provider bodies can contain learner text and
 * upstream identifiers, so only a coarse code and HTTP status are retained.
 */
export async function providerResponseError(
  response: Response,
  context: ProviderRequestContext,
): Promise<AiError> {
  const text = await response.text().catch(() => "");
  const code = providerCodeFromBody(text);
  const retryAfter = retryAfterMs(response.headers);
  const options = {
    providerId: context.providerId,
    modelId: context.modelId,
    httpStatus: response.status,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
  };

  if (response.status === 429) {
    if (code && /quota|credit|billing|exhaust/i.test(code)) {
      return new AiError(
        "quota_exhausted",
        "The provider reported that its free quota is exhausted.",
        {
          ...options,
          ...(retryAfter === undefined ? {} : { quotaResetAt: Date.now() + retryAfter }),
        },
      );
    }
    return new AiError("rate_limited", "The provider rate limit was reached.", options);
  }
  if (response.status === 401 || response.status === 403) {
    if (code && /api_key_invalid|unauthenticated|permission_denied/i.test(code)) {
      return new AiError(
        "authentication_failed",
        "The provider rejected the configured credentials.",
        options,
      );
    }
    return new AiError("authentication_failed", "The provider denied this request.", options);
  }
  if (response.status === 404) {
    return new AiError("unsupported_model", "The configured model is not available.", options);
  }
  if (response.status === 408) {
    return new AiError("timeout", "The provider reported a timeout.", options);
  }
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return new AiError("invalid_request", "The provider rejected the request.", options);
  }
  if (response.status >= 500) {
    return new AiError("provider_unavailable", "The provider is temporarily unavailable.", options);
  }
  return new AiError("provider_unavailable", "The provider request failed.", options);
}

export async function readJsonObject(
  response: Response,
  context: ProviderRequestContext,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new AiError("response_invalid", "The provider returned malformed JSON.", {
      providerId: context.providerId,
      modelId: context.modelId,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiError("response_invalid", "The provider returned an unexpected response.", {
      providerId: context.providerId,
      modelId: context.modelId,
    });
  }
  return parsed as Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
