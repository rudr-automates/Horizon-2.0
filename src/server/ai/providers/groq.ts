import { AiError } from "../errors";
import { readCredential, requireProviderCredentials } from "../credentials";
import type { AiProvider, FinishReason, ProviderCall, ProviderOutput } from "../types";
import { numberValue, providerResponseError, readJsonObject, record, stringValue } from "./http";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

function finishReason(value: unknown): FinishReason {
  if (value === "stop") return "stop";
  if (value === "length") return "length";
  if (value === "content_filter") return "refusal";
  return "unknown";
}

/**
 * Groq's OpenAI-compatible chat endpoint. The adapter never chooses a model:
 * model ids and free-tier eligibility come from server configuration.
 */
export class GroqProvider implements AiProvider {
  readonly id = "groq";
  readonly #env: Record<string, string | undefined>;
  readonly #fetch: typeof fetch;

  constructor(
    env: Record<string, string | undefined> = process.env,
    fetcher: typeof fetch = fetch,
  ) {
    this.#env = env;
    this.#fetch = fetcher;
  }

  isConfigured(): boolean {
    return readCredential(this.#env, "GROQ_API_KEY") !== undefined;
  }

  async complete(call: ProviderCall): Promise<ProviderOutput> {
    requireProviderCredentials(this.#env, this.id);
    const apiKey = readCredential(this.#env, "GROQ_API_KEY");
    if (!apiKey) throw new AiError("missing_credentials", "GROQ_API_KEY is not configured.");

    const reasoningModel =
      call.modelId.startsWith("openai/gpt-oss") || call.modelId.startsWith("qwen/qwen3");
    const body = {
      model: call.modelId,
      messages: call.messages,
      temperature: call.temperature,
      max_completion_tokens: call.maxOutputTokens,
      stream: false,
      ...(reasoningModel ? { reasoning_effort: "low" } : {}),
      ...(call.responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    };

    let response: Response;
    try {
      response = await this.#fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: call.signal,
      });
    } catch (error) {
      if (call.signal.aborted) {
        throw new AiError("aborted", "The provider request was aborted.", {
          providerId: this.id,
          modelId: call.modelId,
        });
      }
      throw new AiError("network_error", "Could not reach the provider.", {
        providerId: this.id,
        modelId: call.modelId,
        cause: error,
      });
    }

    if (!response.ok) {
      throw await providerResponseError(response, {
        providerId: this.id,
        modelId: call.modelId,
      });
    }

    const payload = await readJsonObject(response, {
      providerId: this.id,
      modelId: call.modelId,
    });
    const choices = Array.isArray(payload["choices"]) ? payload["choices"] : [];
    const choice = record(choices[0]);
    const message = record(choice?.["message"]);
    const text = stringValue(message?.["content"])?.trim();
    if (!text) {
      throw new AiError("response_invalid", "The provider returned an empty answer.", {
        providerId: this.id,
        modelId: call.modelId,
      });
    }

    const usage = record(payload["usage"]);
    const promptTokens = numberValue(usage?.["prompt_tokens"]);
    const completionTokens = numberValue(usage?.["completion_tokens"]);

    return {
      text,
      finishReason: finishReason(choice?.["finish_reason"]),
      ...(promptTokens === undefined && completionTokens === undefined
        ? {}
        : {
            usage: {
              ...(promptTokens === undefined ? {} : { inputTokens: promptTokens }),
              ...(completionTokens === undefined ? {} : { outputTokens: completionTokens }),
              source: "provider" as const,
            },
          }),
    };
  }
}
