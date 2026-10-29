import type { AiProvider } from "./types";

/**
 * Holds instantiated provider adapters. Registration is explicit: importing an
 * adapter does not enable it, and an adapter without credentials must report
 * `isConfigured() === false` rather than attempting a call.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, AiProvider>();

  register(provider: AiProvider): this {
    const id = provider.id?.trim();
    if (!id) throw new Error("Provider id must be a non-empty string.");
    if (id !== provider.id) throw new Error("Provider id must not contain surrounding whitespace.");
    if (this.#providers.has(id)) throw new Error(`Provider "${id}" is already registered.`);
    this.#providers.set(id, provider);
    return this;
  }

  get(providerId: string): AiProvider | undefined {
    return this.#providers.get(providerId);
  }

  has(providerId: string): boolean {
    return this.#providers.has(providerId);
  }

  list(): AiProvider[] {
    return [...this.#providers.values()];
  }

  ids(): string[] {
    return [...this.#providers.keys()];
  }
}
