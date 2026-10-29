import { AiError } from "./errors";
import type { AiMessage } from "./types";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface QuotaWindowLimit {
  requests?: number;
  tokens?: number;
}

export interface QuotaPolicy {
  providerId: string;
  modelId: string;
  /** Limits this application enforces. These are always authoritative. */
  application: {
    perMinute?: QuotaWindowLimit;
    perDay?: QuotaWindowLimit;
    concurrency?: number;
  };
  /**
   * Provider-published limits mirrored conservatively. This is not a claim about
   * remaining provider quota; APIs rarely expose that. It only prevents sending
   * requests that clearly exceed the documented window.
   */
  providerPublished?: {
    perMinute?: QuotaWindowLimit;
    perDay?: QuotaWindowLimit;
    source: "documented" | "api_reported";
  };
}

export interface GlobalQuotaLimit {
  perMinute?: QuotaWindowLimit;
  perDay?: QuotaWindowLimit;
  concurrency?: number;
}

interface UsageEvent {
  at: number;
  tokens: number;
  reservationId?: string;
}

export interface QuotaReservation {
  id: string;
  providerId: string;
  modelId: string;
  estimatedTokens: number;
  at: number;
  settled: boolean;
}

export type QuotaDecision =
  | { allowed: true; reservation: QuotaReservation }
  | { allowed: false; error: AiError; global: boolean };

export interface QuotaSnapshot {
  providerId: string;
  modelId: string;
  requestsLastMinute: number;
  tokensLastMinute: number;
  requestsToday: number;
  tokensToday: number;
  /** The provider does not publish remaining quota, so this stays unknown. */
  providerRemaining: "unknown";
  providerQuotaExhaustedUntil?: number;
}

let nextReservationId = 1;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(messages: AiMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/**
 * Simple sliding-window ledger. It is intentionally in-process: there is no
 * shared database or scheduler in this phase. In a multi-isolate deployment
 * each isolate enforces its own share of a limit, so configure limits with that
 * in mind. See docs/AI_PROVIDER_ARCHITECTURE.md.
 */
export class QuotaLedger {
  readonly #policies = new Map<string, QuotaPolicy>();
  readonly #events = new Map<string, UsageEvent[]>();
  readonly #globalEvents: UsageEvent[] = [];
  readonly #cooldowns = new Map<string, number>();
  readonly #exhausted = new Map<string, { until: number; detail: string }>();
  readonly #global: GlobalQuotaLimit;
  readonly #now: () => number;

  constructor(
    policies: QuotaPolicy[],
    global: GlobalQuotaLimit = {},
    now: () => number = Date.now,
  ) {
    this.#global = global;
    this.#now = now;
    for (const policy of policies) {
      this.#policies.set(this.#key(policy.providerId, policy.modelId), policy);
    }
  }

  #key(providerId: string, modelId: string): string {
    return `${providerId}/${modelId}`;
  }

  #prune(events: UsageEvent[], now: number): void {
    const cutoff = now - DAY_MS;
    while (events.length && (events[0]?.at ?? 0) < cutoff) events.shift();
  }

  #usage(
    events: UsageEvent[],
    now: number,
    windowMs = MINUTE_MS,
  ): { requests: number; tokens: number } {
    const cutoff = now - windowMs;
    let requests = 0;
    let tokens = 0;
    for (const event of events) {
      if (event.at < cutoff) continue;
      requests += 1;
      tokens += event.tokens;
    }
    return { requests, tokens };
  }

  #globalUsage(now: number): { requests: number; tokens: number } {
    this.#prune(this.#globalEvents, now);
    return this.#usage(this.#globalEvents, now);
  }

  /** Check limits and reserve estimated usage before the provider call. */
  checkAndReserve(input: {
    providerId: string;
    modelId: string;
    estimatedTokens: number;
    now?: number;
  }): QuotaDecision {
    const now = input.now ?? this.#now();
    const key = this.#key(input.providerId, input.modelId);

    const cooldownUntil = this.#cooldowns.get(input.providerId);
    if (cooldownUntil && cooldownUntil > now) {
      return {
        allowed: false,
        global: false,
        error: new AiError("rate_limited", "The provider asked us to wait before retrying.", {
          providerId: input.providerId,
          modelId: input.modelId,
          retryAfterMs: cooldownUntil - now,
        }),
      };
    }

    const exhausted = this.#exhausted.get(key) ?? this.#exhausted.get(input.providerId);
    if (exhausted && exhausted.until > now) {
      return {
        allowed: false,
        global: false,
        error: new AiError(
          "quota_exhausted",
          "The provider's configured quota window is exhausted.",
          {
            providerId: input.providerId,
            modelId: input.modelId,
            quotaResetAt: exhausted.until,
          },
        ),
      };
    }

    const globalMinute = this.#globalUsage(now);
    const globalDay = this.#usage(this.#globalEvents, now, DAY_MS);
    const globalError = this.#windowError(
      this.#global,
      globalMinute,
      globalDay,
      input.estimatedTokens,
      now,
      true,
      "application",
      input,
    );
    if (globalError) return { allowed: false, error: globalError, global: true };

    const policy = this.#policies.get(key);
    if (!policy) {
      return {
        allowed: false,
        global: false,
        error: new AiError(
          "application_limit_exceeded",
          "No quota policy is configured for this model, so it cannot be used.",
          { providerId: input.providerId, modelId: input.modelId, fallbackAllowed: true },
        ),
      };
    }

    const events = this.#events.get(key) ?? [];
    this.#prune(events, now);
    const minute = this.#usage(events, now);
    const day = this.#usage(events, now, DAY_MS);

    const applicationError = this.#windowError(
      policy.application,
      minute,
      day,
      input.estimatedTokens,
      now,
      false,
      "application",
      input,
    );
    if (applicationError) return { allowed: false, error: applicationError, global: false };

    if (policy.providerPublished) {
      const providerError = this.#windowError(
        policy.providerPublished,
        minute,
        day,
        input.estimatedTokens,
        now,
        false,
        "provider",
        input,
      );
      if (providerError) return { allowed: false, error: providerError, global: false };
    }

    const reservation: QuotaReservation = {
      id: `q${nextReservationId++}`,
      providerId: input.providerId,
      modelId: input.modelId,
      estimatedTokens: Math.max(0, Math.ceil(input.estimatedTokens)),
      at: now,
      settled: false,
    };
    events.push({ at: now, tokens: reservation.estimatedTokens, reservationId: reservation.id });
    this.#events.set(key, events);
    this.#globalEvents.push({ at: now, tokens: reservation.estimatedTokens });
    return { allowed: true, reservation };
  }

  #windowError(
    limits: { perMinute?: QuotaWindowLimit; perDay?: QuotaWindowLimit },
    minute: { requests: number; tokens: number },
    day: { requests: number; tokens: number },
    extraTokens: number,
    now: number,
    isGlobal: boolean,
    source: "application" | "provider",
    input: { providerId: string; modelId: string },
  ): AiError | undefined {
    const perMinute = limits.perMinute;
    if (perMinute) {
      if (perMinute.requests !== undefined && minute.requests + 1 > perMinute.requests) {
        return this.#limitError(
          "per minute",
          now + MINUTE_MS,
          now,
          isGlobal,
          source,
          input,
          "requests",
        );
      }
      if (perMinute.tokens !== undefined && minute.tokens + extraTokens > perMinute.tokens) {
        return this.#limitError(
          "per minute",
          now + MINUTE_MS,
          now,
          isGlobal,
          source,
          input,
          "tokens",
        );
      }
    }
    const perDay = limits.perDay;
    if (perDay) {
      if (perDay.requests !== undefined && day.requests + 1 > perDay.requests) {
        return this.#limitError("daily", now + DAY_MS, now, isGlobal, source, input, "requests");
      }
      if (perDay.tokens !== undefined && day.tokens + extraTokens > perDay.tokens) {
        return this.#limitError("daily", now + DAY_MS, now, isGlobal, source, input, "tokens");
      }
    }
    return undefined;
  }

  #limitError(
    window: string,
    resetAt: number,
    now: number,
    isGlobal: boolean,
    source: "application" | "provider",
    input: { providerId: string; modelId: string },
    unit: "requests" | "tokens",
  ): AiError {
    if (isGlobal || source === "application") {
      return new AiError(
        "application_limit_exceeded",
        `Application ${window} ${unit} limit reached. No paid fallback will be used.`,
        {
          providerId: input.providerId,
          modelId: input.modelId,
          quotaResetAt: resetAt,
          retryAfterMs: Math.max(0, resetAt - now),
          fallbackAllowed: !isGlobal,
        },
      );
    }
    return new AiError(
      "quota_exhausted",
      `The configured ${window} provider allowance is exhausted.`,
      {
        providerId: input.providerId,
        modelId: input.modelId,
        quotaResetAt: resetAt,
        fallbackAllowed: true,
      },
    );
  }

  /**
   * Provider-reported token usage can exceed our estimate. Record only the
   * upward difference: over-counting is safe for a spending guard, while
   * under-counting is not.
   */
  settle(reservation: QuotaReservation, actualTokens: number): void {
    if (reservation.settled) return;
    reservation.settled = true;
    const delta = Math.max(0, Math.ceil(actualTokens) - reservation.estimatedTokens);
    if (delta <= 0) return;
    const key = this.#key(reservation.providerId, reservation.modelId);
    const events = this.#events.get(key) ?? [];
    events.push({ at: this.#now(), tokens: delta });
    this.#events.set(key, events);
    this.#globalEvents.push({ at: this.#now(), tokens: delta });
  }

  markRateLimited(providerId: string, retryAfterMs: number): void {
    const until = this.#now() + Math.max(0, retryAfterMs);
    const current = this.#cooldowns.get(providerId) ?? 0;
    this.#cooldowns.set(providerId, Math.max(current, until));
  }

  markProviderExhausted(
    providerId: string,
    modelId: string,
    resetAt: number,
    detail = "provider_reported",
  ): void {
    const key = this.#key(providerId, modelId);
    this.#exhausted.set(key, { until: resetAt, detail });
  }

  markProviderAvailable(providerId: string, modelId: string): void {
    this.#exhausted.delete(this.#key(providerId, modelId));
    this.#cooldowns.delete(providerId);
  }

  concurrencyLimit(providerId: string, modelId: string): number | undefined {
    return this.#policies.get(this.#key(providerId, modelId))?.application.concurrency;
  }

  globalConcurrencyLimit(): number | undefined {
    return this.#global.concurrency;
  }

  snapshot(now = this.#now()): QuotaSnapshot[] {
    return [...this.#policies.values()].map((policy) => {
      const key = this.#key(policy.providerId, policy.modelId);
      const events = this.#events.get(key) ?? [];
      this.#prune(events, now);
      const minute = this.#usage(events, now);
      const day = this.#usage(events, now, DAY_MS);
      const exhausted = this.#exhausted.get(key) ?? this.#exhausted.get(policy.providerId);
      return {
        providerId: policy.providerId,
        modelId: policy.modelId,
        requestsLastMinute: minute.requests,
        tokensLastMinute: minute.tokens,
        requestsToday: day.requests,
        tokensToday: day.tokens,
        providerRemaining: "unknown" as const,
        ...(exhausted && exhausted.until > now
          ? { providerQuotaExhaustedUntil: exhausted.until }
          : {}),
      };
    });
  }
}

/** Counts in-flight calls per key without blocking. */
export class ConcurrencyGuard {
  readonly #active = new Map<string, number>();

  tryAcquire(key: string, limit: number): boolean {
    const current = this.#active.get(key) ?? 0;
    if (current >= limit) return false;
    this.#active.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.#active.get(key) ?? 0;
    if (current <= 1) this.#active.delete(key);
    else this.#active.set(key, current - 1);
  }

  active(key: string): number {
    return this.#active.get(key) ?? 0;
  }
}
