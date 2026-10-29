import "@tanstack/react-start/server-only";

import { AiError } from "./errors";

/**
 * Environment variable names only. Values are read lazily on the server and
 * must never be logged, serialized into responses, or imported by client code.
 */
export const PROVIDER_CREDENTIAL_ENV: Readonly<Record<string, readonly string[]>> = {
  gemini: ["GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  "cloudflare-workers-ai": ["CLOUDFLARE_AI_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  jina: ["JINA_API_KEY"],
};

const PLACEHOLDER_PREFIXES = ["<", "your-", "your_", "changeme", "replace-me", "example"];

function isUsable(value: string | undefined): value is string {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return !PLACEHOLDER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export interface CredentialStatus {
  providerId: string;
  configured: boolean;
  /** Variable names that are absent or still placeholders. Never their values. */
  missing: string[];
}

export function credentialStatus(
  env: Record<string, string | undefined>,
  providerId: string,
): CredentialStatus {
  const names = PROVIDER_CREDENTIAL_ENV[providerId] ?? [];
  const missing = names.filter((name) => !isUsable(env[name]));
  return {
    providerId,
    configured: names.length > 0 && missing.length === 0,
    missing,
  };
}

/** Server-only accessor for an adapter. Do not log the returned value. */
export function readCredential(
  env: Record<string, string | undefined>,
  variableName: string,
): string | undefined {
  const value = env[variableName];
  return isUsable(value) ? value.trim() : undefined;
}

export function requireProviderCredentials(
  env: Record<string, string | undefined>,
  providerId: string,
): void {
  const status = credentialStatus(env, providerId);
  if (!status.configured) {
    throw new AiError(
      "missing_credentials",
      `Provider "${providerId}" is not configured. Missing: ${status.missing.join(", ") || "credential mapping"}.`,
      { providerId },
    );
  }
}
