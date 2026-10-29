import type { AiProvider, ProviderHealth } from "./types";

/**
 * Small in-process circuit breaker. It remembers provider-level failures
 * (usually bad credentials or a prolonged outage) so every learner request does
 * not rediscover the same problem. It is deliberately not a distributed
 * scheduler; see docs/AI_PROVIDER_ARCHITECTURE.md for the deployment caveat.
 */
export class ProviderHealthTracker {
  readonly #blockedUntil = new Map<string, { until: number; detail: string }>();

  markUnhealthy(providerId: string, cooldownMs: number, now: number, detail = "unhealthy") {
    this.#blockedUntil.set(providerId, { until: now + Math.max(0, cooldownMs), detail });
  }

  markHealthy(providerId: string) {
    this.#blockedUntil.delete(providerId);
  }

  isAvailable(providerId: string, now: number): boolean {
    const blocked = this.#blockedUntil.get(providerId);
    return !blocked || blocked.until <= now;
  }

  snapshot(now: number): Array<{ providerId: string; available: boolean; detail?: string }> {
    return [...this.#blockedUntil.entries()].map(([providerId, blocked]) => ({
      providerId,
      available: blocked.until <= now,
      detail: blocked.detail,
    }));
  }

  /** Optional live probe; never throws. */
  async probe(provider: AiProvider, now = Date.now()): Promise<ProviderHealth> {
    if (!this.isAvailable(provider.id, now)) {
      return { status: "degraded", checkedAt: now, detail: "circuit_open" };
    }
    if (!provider.health) return { status: "unknown", checkedAt: now };
    try {
      return await provider.health();
    } catch {
      return { status: "degraded", checkedAt: now, detail: "health_check_failed" };
    }
  }
}
