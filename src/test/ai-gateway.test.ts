import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GATEWAY_CONFIG,
  loadGatewayConfig,
  validateGatewayConfig,
} from "@/server/ai/config";
import { AiError } from "@/server/ai/errors";
import { AiGateway } from "@/server/ai/gateway";
import { sanitizeLogFields, type AiLogFields, type AiLogger } from "@/server/ai/logging";
import { MockAiProvider } from "@/server/ai/mock-provider";
import { ProviderRegistry } from "@/server/ai/registry";
import { credentialStatus } from "@/server/ai/credentials";
import { QuotaLedger, type GlobalQuotaLimit, type QuotaPolicy } from "@/server/ai/quota";
import type { AiProvider, GatewayConfig, GatewayModelConfig } from "@/server/ai/types";

const CLOCK_START = 1_000_000;

function models(...ids: Array<[string, string]>): GatewayModelConfig[] {
  return ids.map(([providerId, modelId]) => ({
    providerId,
    modelId,
    tier: "free",
    enabled: true,
  }));
}

function makeConfig(
  entries: GatewayModelConfig[],
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    ...DEFAULT_GATEWAY_CONFIG,
    models: entries,
    timeoutMs: 100,
    attemptsPerProvider: 2,
    totalAttempts: 4,
    backoff: { baseDelayMs: 10, maxDelayMs: 20, jitterRatio: 0 },
    maxInlineRetryDelayMs: 50,
    ...overrides,
    limits: { ...DEFAULT_GATEWAY_CONFIG.limits, ...overrides.limits },
  };
}

function policies(
  entries: GatewayModelConfig[],
  application: QuotaPolicy["application"] = { concurrency: 2 },
): QuotaPolicy[] {
  return entries.map((entry) => ({
    providerId: entry.providerId,
    modelId: entry.modelId,
    application,
  }));
}

function registryOf(...providers: AiProvider[]): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

function setup(options: {
  providers: AiProvider[];
  entries: GatewayModelConfig[];
  config?: Partial<GatewayConfig>;
  application?: QuotaPolicy["application"];
  global?: GlobalQuotaLimit;
  logger?: AiLogger;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  const config = makeConfig(options.entries, options.config);
  const now = options.now ?? (() => CLOCK_START);
  const quota = new QuotaLedger(
    policies(options.entries, options.application),
    options.global ?? {},
    now,
  );
  const gateway = new AiGateway({
    registry: registryOf(...options.providers),
    config,
    quota,
    now,
    sleep: options.sleep ?? (async () => {}),
    random: () => 0.5,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { gateway, quota, config };
}

const request = { messages: [{ role: "user" as const, content: "What is an embedding?" }] };

describe("AI gateway selection and responses", () => {
  it("returns a provider completion with reported token usage", async () => {
    const provider = new MockAiProvider({ id: "a" }).enqueue({
      kind: "success",
      text: "A vector representation.",
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    const { gateway } = setup({ providers: [provider], entries: models(["a", "alpha"]) });

    const result = await gateway.generate(request);

    expect(result.text).toBe("A vector representation.");
    expect(result.providerId).toBe("a");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 6, source: "provider" });
    expect(result.fallbackUsed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  it("does not invent usage the provider did not report", async () => {
    const provider = new MockAiProvider({ id: "a" });
    const { gateway } = setup({ providers: [provider], entries: models(["a", "alpha"]) });

    const result = await gateway.generate(request);

    expect(result.usage).toEqual({ source: "unknown" });
  });

  it("skips an unconfigured provider and reports the fallback", async () => {
    const missing = new MockAiProvider({ id: "a", configured: false });
    const working = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [missing, working],
      entries: models(["a", "alpha"], ["b", "beta"]),
    });

    const result = await gateway.generate(request);

    expect(result.providerId).toBe("b");
    expect(result.fallbackUsed).toBe(true);
    expect(missing.calls).toHaveLength(0);
    expect(working.calls).toHaveLength(1);
  });

  it("returns a clear error when every provider lacks credentials", async () => {
    const missing = new MockAiProvider({ id: "a", configured: false });
    const { gateway } = setup({ providers: [missing], entries: models(["a", "alpha"]) });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(missing.calls).toHaveLength(0);
  });

  it("never calls a provider that is not in the configured free list", async () => {
    const free = new MockAiProvider({ id: "free" })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") });
    const paid = new MockAiProvider({ id: "paid", defaultText: "paid answer" });
    const { gateway } = setup({
      providers: [free, paid],
      entries: models(["free", "free-model"]),
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(paid.calls).toHaveLength(0);
  });
});

describe("AI gateway retry and fallback policy", () => {
  it("opens a health circuit after an authentication failure", async () => {
    const badCredentials = new MockAiProvider({ id: "a" }).enqueue({
      kind: "error",
      error: new AiError("authentication_failed", "bad key"),
    });
    const working = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [badCredentials, working],
      entries: models(["a", "alpha"], ["b", "beta"]),
    });

    const first = await gateway.generate(request);
    const second = await gateway.generate(request);

    expect(first.providerId).toBe("b");
    expect(second.providerId).toBe("b");
    expect(badCredentials.calls).toHaveLength(1);
  });

  it("switches providers for a rate limit with a long Retry-After", async () => {
    const limited = new MockAiProvider({ id: "a" }).enqueue({
      kind: "error",
      error: new AiError("rate_limited", "slow down", { retryAfterMs: 5_000 }),
    });
    const working = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [limited, working],
      entries: models(["a", "alpha"], ["b", "beta"]),
    });

    const result = await gateway.generate(request);

    expect(result.providerId).toBe("b");
    expect(limited.calls).toHaveLength(1);
  });

  it("honours a short Retry-After by retrying the same provider in bounds", async () => {
    const provider = new MockAiProvider({ id: "a" })
      .enqueue({
        kind: "error",
        error: new AiError("rate_limited", "slow down", { retryAfterMs: 10 }),
      })
      .enqueue({ kind: "success", text: "recovered" });
    let now = CLOCK_START;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const { gateway } = setup({
      providers: [provider],
      entries: models(["a", "alpha"]),
      sleep,
      now: () => now,
    });

    const result = await gateway.generate(request);

    expect(result.text).toBe("recovered");
    expect(result.attempts).toHaveLength(2);
    expect(result.fallbackUsed).toBe(false);
    expect(sleep).toHaveBeenCalledWith(10, undefined);
  });

  it("switches providers after provider quota exhaustion and remembers it", async () => {
    const exhausted = new MockAiProvider({ id: "a" }).enqueue({
      kind: "error",
      error: new AiError("quota_exhausted", "daily quota used", {
        quotaResetAt: CLOCK_START + 60_000,
      }),
    });
    const working = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [exhausted, working],
      entries: models(["a", "alpha"], ["b", "beta"]),
    });

    const first = await gateway.generate(request);
    const second = await gateway.generate(request);

    expect(first.providerId).toBe("b");
    expect(second.providerId).toBe("b");
    expect(exhausted.calls).toHaveLength(1);
  });

  it("counts every provider attempt against the application request budget", async () => {
    const failing = new MockAiProvider({ id: "a" })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "success", text: "should not be reached" });
    const { gateway } = setup({
      providers: [failing],
      entries: models(["a", "alpha"]),
      application: { concurrency: 2, perMinute: { requests: 1 } },
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(failing.calls).toHaveLength(1);
  });

  it("retries a reversible provider failure but stops at the attempt bound", async () => {
    const failing = new MockAiProvider({ id: "a" })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "success", text: "should not be reached" });
    const { gateway } = setup({ providers: [failing], entries: models(["a", "alpha"]) });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(failing.calls).toHaveLength(2);
  });

  it("caps total attempts across providers", async () => {
    const a = new MockAiProvider({ id: "a" })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") });
    const b = new MockAiProvider({ id: "b" })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") })
      .enqueue({ kind: "error", error: new AiError("provider_unavailable", "down") });
    const { gateway } = setup({
      providers: [a, b],
      entries: models(["a", "alpha"], ["b", "beta"]),
      config: { attemptsPerProvider: 2, totalAttempts: 3 },
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(1);
  });

  it("does not retry or fall back for an invalid request", async () => {
    const provider = new MockAiProvider({ id: "a" });
    const { gateway } = setup({
      providers: [provider],
      entries: models(["a", "alpha"]),
      config: {
        limits: {
          ...DEFAULT_GATEWAY_CONFIG.limits,
          maxTotalInputChars: 5,
          maxMessageChars: 5,
        },
      },
    });

    await expect(
      gateway.generate({ messages: [{ role: "user", content: "too long for the limit" }] }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(provider.calls).toHaveLength(0);
  });

  it("does not retry a refusal or use another provider to bypass it", async () => {
    const refusing = new MockAiProvider({ id: "a" }).enqueue({
      kind: "error",
      error: new AiError("content_refused", "The model declined."),
    });
    const working = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [refusing, working],
      entries: models(["a", "alpha"], ["b", "beta"]),
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({ code: "content_refused" });
    expect(refusing.calls).toHaveLength(1);
    expect(working.calls).toHaveLength(0);
  });
});

describe("AI gateway timeouts and cancellation", () => {
  it("times out without retrying or duplicating the request", async () => {
    const hanging = new MockAiProvider({ id: "a" }).enqueue({ kind: "hang" });
    const other = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [hanging, other],
      entries: models(["a", "alpha"], ["b", "beta"]),
      config: { timeoutMs: 100 },
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({ code: "timeout" });
    expect(hanging.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(0);
  });

  it("honours an already-cancelled caller signal without calling a provider", async () => {
    const provider = new MockAiProvider({ id: "a" });
    const { gateway } = setup({ providers: [provider], entries: models(["a", "alpha"]) });
    const controller = new AbortController();
    controller.abort();

    await expect(gateway.generate({ ...request, signal: controller.signal })).rejects.toMatchObject(
      { code: "aborted" },
    );
    expect(provider.calls).toHaveLength(0);
  });
});

describe("AI gateway application guards", () => {
  it("stops at the global application budget without trying another provider", async () => {
    const a = new MockAiProvider({ id: "a" });
    const b = new MockAiProvider({ id: "b" });
    const { gateway } = setup({
      providers: [a, b],
      entries: models(["a", "alpha"], ["b", "beta"]),
      global: { perDay: { requests: 1 } },
    });

    await expect(gateway.generate(request)).resolves.toMatchObject({ providerId: "a" });
    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "application_limit_exceeded",
    });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
  });

  it("fails closed when a configured model has no quota policy", async () => {
    const provider = new MockAiProvider({ id: "a" });
    const config = makeConfig(models(["a", "alpha"]));
    const gateway = new AiGateway({
      registry: registryOf(provider),
      config,
      quota: new QuotaLedger([]),
      now: () => CLOCK_START,
      sleep: async () => {},
      random: () => 0.5,
    });

    await expect(gateway.generate(request)).rejects.toMatchObject({
      code: "all_providers_unavailable",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a paid model configuration and malformed environment preferences", () => {
    const paid = models(["a", "alpha"]).map((model) => ({ ...model, tier: "paid" as const }));
    expect(() => validateGatewayConfig(makeConfig(paid))).toThrow(AiError);
    expect(() => loadGatewayConfig({ AI_MODEL_PREFERENCES: "not-json" })).toThrow(AiError);
    expect(() =>
      loadGatewayConfig({
        AI_MODEL_PREFERENCES: JSON.stringify([{ providerId: "a", modelId: "alpha", tier: "paid" }]),
      }),
    ).toThrow(AiError);
    expect(loadGatewayConfig({}).models).toEqual([]);
    expect(
      loadGatewayConfig({
        AI_MODEL_PREFERENCES: JSON.stringify([{ providerId: "a", modelId: "alpha", tier: "free" }]),
      }).models,
    ).toHaveLength(1);
    expect(() =>
      validateGatewayConfig(
        makeConfig([], {
          backoff: { baseDelayMs: 10, maxDelayMs: 20, jitterRatio: 2 },
        }),
      ),
    ).toThrow(AiError);
    expect(() =>
      validateGatewayConfig(
        makeConfig(models(["a", "alpha"]), {
          limits: { ...DEFAULT_GATEWAY_CONFIG.limits, maxMessageChars: 30_000 },
        }),
      ),
    ).toThrow(AiError);
  });
});

describe("AI logging and credential reporting", () => {
  it("keeps learner content and unknown fields out of logs", async () => {
    const events: Array<{ event: string; fields: AiLogFields }> = [];
    const logger: AiLogger = {
      info: (event, fields) => events.push({ event, fields: fields ?? {} }),
      warn: (event, fields) => events.push({ event, fields: fields ?? {} }),
      error: (event, fields) => events.push({ event, fields: fields ?? {} }),
    };
    const provider = new MockAiProvider({ id: "a" });
    const { gateway } = setup({ providers: [provider], entries: models(["a", "alpha"]), logger });

    await gateway.generate({
      messages: [{ role: "user", content: "PRIVATE_LEARNER_TEXT_123" }],
    });

    expect(JSON.stringify(events)).not.toContain("PRIVATE_LEARNER_TEXT_123");
    const cleaned = sanitizeLogFields({
      correlationId: "corr-1",
      reason: "x".repeat(200),
      apiKey: "sk-secret",
    } as AiLogFields);
    expect(cleaned["correlationId"]).toBe("corr-1");
    expect(cleaned["reason"]).toHaveLength(81);
    expect(cleaned).not.toHaveProperty("apiKey");
  });

  it("reports only missing environment names, never values", () => {
    const status = credentialStatus({}, "gemini");
    expect(status).toEqual({
      providerId: "gemini",
      configured: false,
      missing: ["GEMINI_API_KEY"],
    });
    expect(credentialStatus({ GEMINI_API_KEY: "<your-key>" }, "gemini").configured).toBe(false);
    expect(credentialStatus({ GEMINI_API_KEY: "test-placeholder-value" }, "gemini")).toMatchObject({
      configured: true,
      missing: [],
    });
    expect(credentialStatus({}, "unknown-provider").configured).toBe(false);
  });
});
