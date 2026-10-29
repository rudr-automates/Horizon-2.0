import { describe, expect, it } from "vitest";
import {
  ConcurrencyGuard,
  QuotaLedger,
  estimateMessageTokens,
  type QuotaPolicy,
} from "@/server/ai/quota";

const START = 1_000_000;

function policy(
  application: QuotaPolicy["application"],
  providerPublished?: QuotaPolicy["providerPublished"],
): QuotaPolicy {
  return {
    providerId: "provider-a",
    modelId: "model-a",
    application,
    ...(providerPublished === undefined ? {} : { providerPublished }),
  };
}

function ledger(
  application: QuotaPolicy["application"] = {},
  options: {
    global?: {
      perMinute?: { requests?: number; tokens?: number };
      perDay?: { requests?: number; tokens?: number };
    };
    published?: QuotaPolicy["providerPublished"];
  } = {},
) {
  let now = START;
  const instance = new QuotaLedger(
    [policy(application, options.published)],
    options.global ?? {},
    () => now,
  );
  return {
    instance,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

describe("quota ledger", () => {
  it("tracks usage without claiming to know provider remaining quota", () => {
    const { instance } = ledger();
    const decision = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 10,
    });

    expect(decision.allowed).toBe(true);
    const snapshot = instance.snapshot();
    expect(snapshot[0]).toMatchObject({
      requestsLastMinute: 1,
      tokensLastMinute: 10,
      requestsToday: 1,
      providerRemaining: "unknown",
    });
    expect(snapshot[0]).not.toHaveProperty("remaining");
  });

  it("distinguishes an application per-model limit from provider exhaustion", () => {
    const { instance } = ledger({ perDay: { requests: 1 } });
    expect(
      instance.checkAndReserve({
        providerId: "provider-a",
        modelId: "model-a",
        estimatedTokens: 1,
      }).allowed,
    ).toBe(true);

    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.global).toBe(false);
    expect(denied.error.code).toBe("application_limit_exceeded");
    expect(denied.error.fallbackAllowed).toBe(true);
  });

  it("stops all providers at the global application guard", () => {
    const { instance } = ledger({}, { global: { perDay: { requests: 1 } } });
    expect(
      instance.checkAndReserve({
        providerId: "provider-a",
        modelId: "model-a",
        estimatedTokens: 1,
      }).allowed,
    ).toBe(true);

    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.global).toBe(true);
    expect(denied.error.fallbackAllowed).toBe(false);
  });

  it("treats a mirrored provider-published window as provider quota, not app spend", () => {
    const { instance } = ledger(
      {},
      { published: { perMinute: { requests: 1 }, source: "documented" } },
    );
    expect(
      instance.checkAndReserve({
        providerId: "provider-a",
        modelId: "model-a",
        estimatedTokens: 1,
      }).allowed,
    ).toBe(true);

    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.error.code).toBe("quota_exhausted");
    expect(denied.error.fallbackAllowed).toBe(true);
  });

  it("honours provider exhaustion until its reset time", () => {
    const { instance, advance } = ledger();
    instance.markProviderExhausted("provider-a", "model-a", START + 1_000);

    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.error.code).toBe("quota_exhausted");

    advance(1_001);
    expect(
      instance.checkAndReserve({
        providerId: "provider-a",
        modelId: "model-a",
        estimatedTokens: 1,
      }).allowed,
    ).toBe(true);
  });

  it("respects a rate-limit cooldown without calling it quota exhaustion", () => {
    const { instance, advance } = ledger();
    instance.markRateLimited("provider-a", 5_000);

    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.error.code).toBe("rate_limited");
    expect(denied.error.retryAfterMs).toBe(5_000);

    advance(5_001);
    expect(
      instance.checkAndReserve({
        providerId: "provider-a",
        modelId: "model-a",
        estimatedTokens: 1,
      }).allowed,
    ).toBe(true);
  });

  it("settles upward only, so a provider under-report cannot lower spend", () => {
    const { instance } = ledger();
    const decision = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 5,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;

    instance.settle(decision.reservation, 50);
    instance.settle(decision.reservation, 1);
    const snapshot = instance.snapshot();
    expect(snapshot[0]?.tokensLastMinute).toBe(50);
  });

  it("estimates tokens conservatively without pretending to tokenize exactly", () => {
    expect(estimateMessageTokens([{ role: "user", content: "123456789" }])).toBe(3);
    expect(estimateMessageTokens([{ role: "user", content: "" }])).toBe(1);
  });

  it("refuses a model with no quota policy", () => {
    const instance = new QuotaLedger([], {}, () => START);
    const denied = instance.checkAndReserve({
      providerId: "provider-a",
      modelId: "model-a",
      estimatedTokens: 1,
    });
    expect(denied.allowed).toBe(false);
    if (denied.allowed) return;
    expect(denied.error.code).toBe("application_limit_exceeded");
  });
});

describe("concurrency guard", () => {
  it("does not block unrelated providers and releases slots", () => {
    const guard = new ConcurrencyGuard();
    expect(guard.tryAcquire("a", 1)).toBe(true);
    expect(guard.tryAcquire("a", 1)).toBe(false);
    expect(guard.tryAcquire("b", 1)).toBe(true);
    guard.release("a");
    expect(guard.tryAcquire("a", 1)).toBe(true);
  });
});
