import { EmbeddingError } from "./errors";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface EmbeddingRateLimits {
  requestsPerMinute?: number;
  inputsPerDay?: number;
  charsPerDay?: number;
}

interface BatchEvent {
  at: number;
  inputs: number;
  chars: number;
}

/**
 * In-process guard for embedding fan-out. Like the LLM quota ledger, this is a
 * per-isolate guard, not a distributed quota service.
 */
export class EmbeddingUsageGuard {
  readonly #events: BatchEvent[] = [];
  readonly #limits: EmbeddingRateLimits;
  readonly #now: () => number;

  constructor(limits: EmbeddingRateLimits = {}, now: () => number = Date.now) {
    this.#limits = limits;
    this.#now = now;
  }

  checkAndRecord(inputs: number, chars: number): void {
    const now = this.#now();
    while (this.#events.length && (this.#events[0]?.at ?? 0) < now - DAY_MS) {
      this.#events.shift();
    }
    const lastMinute = this.#events.filter((event) => event.at >= now - MINUTE_MS);
    const today = this.#events.filter((event) => event.at >= now - DAY_MS);

    if (
      this.#limits.requestsPerMinute !== undefined &&
      lastMinute.length + 1 > this.#limits.requestsPerMinute
    ) {
      throw new EmbeddingError(
        "application_limit_exceeded",
        "The application embedding request limit was reached. Try again shortly.",
        { retryAfterMs: MINUTE_MS },
      );
    }
    const dailyInputs = today.reduce((sum, event) => sum + event.inputs, 0);
    if (
      this.#limits.inputsPerDay !== undefined &&
      dailyInputs + inputs > this.#limits.inputsPerDay
    ) {
      throw new EmbeddingError(
        "application_limit_exceeded",
        "The application embedding input quota is exhausted for today.",
        { retryAfterMs: DAY_MS },
      );
    }
    const dailyChars = today.reduce((sum, event) => sum + event.chars, 0);
    if (this.#limits.charsPerDay !== undefined && dailyChars + chars > this.#limits.charsPerDay) {
      throw new EmbeddingError(
        "application_limit_exceeded",
        "The application embedding character quota is exhausted for today.",
        { retryAfterMs: DAY_MS },
      );
    }

    this.#events.push({ at: now, inputs, chars });
  }

  snapshot(): { requestsLastMinute: number; inputsToday: number; charsToday: number } {
    const now = this.#now();
    return {
      requestsLastMinute: this.#events.filter((event) => event.at >= now - MINUTE_MS).length,
      inputsToday: this.#events
        .filter((event) => event.at >= now - DAY_MS)
        .reduce((sum, event) => sum + event.inputs, 0),
      charsToday: this.#events
        .filter((event) => event.at >= now - DAY_MS)
        .reduce((sum, event) => sum + event.chars, 0),
    };
  }
}
