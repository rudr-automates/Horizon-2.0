import { AiError } from "./errors";
import type { AiProvider, FinishReason, ProviderCall, ProviderOutput, TokenUsage } from "./types";

export type MockResponse =
  | {
      kind: "success";
      text?: string;
      usage?: Partial<Omit<TokenUsage, "source">> & { source?: TokenUsage["source"] };
      finishReason?: FinishReason;
    }
  | { kind: "error"; error: AiError }
  | { kind: "hang" };

export interface MockCallRecord {
  modelId: string;
  correlationId: string;
  messageCount: number;
  inputChars: number;
  maxOutputTokens: number;
  temperature: number;
}

/**
 * Deterministic provider for unit tests. It makes no network calls, never
 * requires credentials and records only call metadata (never message text).
 */
export class MockAiProvider implements AiProvider {
  readonly id: string;
  readonly calls: MockCallRecord[] = [];
  readonly #responses: MockResponse[];
  readonly #configured: boolean;
  readonly #defaultText: string;
  #callCount = 0;

  constructor(
    options: {
      id?: string;
      configured?: boolean;
      responses?: MockResponse[];
      defaultText?: string;
    } = {},
  ) {
    this.id = options.id ?? "mock";
    this.#configured = options.configured ?? true;
    this.#responses = [...(options.responses ?? [])];
    this.#defaultText = options.defaultText ?? "deterministic mock answer";
  }

  enqueue(response: MockResponse): this {
    this.#responses.push(response);
    return this;
  }

  isConfigured(): boolean {
    return this.#configured;
  }

  async complete(call: ProviderCall): Promise<ProviderOutput> {
    this.calls.push({
      modelId: call.modelId,
      correlationId: call.correlationId,
      messageCount: call.messages.length,
      inputChars: call.messages.reduce((sum, message) => sum + message.content.length, 0),
      maxOutputTokens: call.maxOutputTokens,
      temperature: call.temperature,
    });
    this.#callCount += 1;

    const response = this.#responses.shift();
    if (!response) {
      return {
        text: `${this.#defaultText} #${this.#callCount}`,
        finishReason: "stop",
      };
    }
    if (response.kind === "error") throw response.error;
    if (response.kind === "hang") {
      return new Promise<ProviderOutput>(() => {
        // Intentionally ignores AbortSignal to exercise gateway timeouts.
      });
    }
    return {
      text: response.text ?? `${this.#defaultText} #${this.#callCount}`,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      finishReason: response.finishReason ?? "stop",
    };
  }
}
