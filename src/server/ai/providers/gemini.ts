import { AiError } from "../errors";
import { readCredential, requireProviderCredentials } from "../credentials";
import type { AiMessage, AiProvider, FinishReason, ProviderCall, ProviderOutput } from "../types";
import { numberValue, providerResponseError, readJsonObject, record, stringValue } from "./http";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function finishReason(value: unknown): FinishReason {
  if (value === "STOP") return "stop";
  if (value === "MAX_TOKENS") return "length";
  if (value === "SAFETY" || value === "RECITATION" || value === "BLOCKLIST") return "refusal";
  return "unknown";
}

function geminiContents(messages: AiMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const previous = contents.at(-1);
    if (previous && previous["role"] === role) {
      const parts = Array.isArray(previous["parts"]) ? previous["parts"] : [];
      parts.push({ text: message.content });
      previous["parts"] = parts;
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }
  return contents;
}

/**
 * Google's generateContent endpoint. The model id is supplied by the gateway
 * configuration so a retired free-tier model can be replaced without a code
 * change.
 */
export class GeminiProvider implements AiProvider {
  readonly id = "gemini";
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
    return readCredential(this.#env, "GEMINI_API_KEY") !== undefined;
  }

  async complete(call: ProviderCall): Promise<ProviderOutput> {
    requireProviderCredentials(this.#env, this.id);
    const apiKey = readCredential(this.#env, "GEMINI_API_KEY");
    if (!apiKey) throw new AiError("missing_credentials", "GEMINI_API_KEY is not configured.");

    const systemText = call.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const body = {
      contents: geminiContents(call.messages),
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      generationConfig: {
        maxOutputTokens: call.maxOutputTokens,
        temperature: call.temperature,
        ...(call.responseFormat === "json" ? { responseMimeType: "application/json" } : {}),
      },
    };

    let response: Response;
    try {
      response = await this.#fetch(
        `${GEMINI_ENDPOINT}/${encodeURIComponent(call.modelId)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: call.signal,
        },
      );
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

    const promptFeedback = record(payload["promptFeedback"]);
    if (promptFeedback?.["blockReason"]) {
      throw new AiError("content_refused", "The provider declined this request.", {
        providerId: this.id,
        modelId: call.modelId,
      });
    }

    const candidates = Array.isArray(payload["candidates"]) ? payload["candidates"] : [];
    const candidate = record(candidates[0]);
    const content = record(candidate?.["content"]);
    const parts = Array.isArray(content?.["parts"]) ? content["parts"] : [];
    const text = parts
      .map((part) => stringValue(record(part)?.["text"]) ?? "")
      .join("")
      .trim();

    if (!text) {
      const reason = candidate?.["finishReason"];
      if (reason === "SAFETY" || reason === "RECITATION") {
        throw new AiError("content_refused", "The provider declined this request.", {
          providerId: this.id,
          modelId: call.modelId,
        });
      }
      throw new AiError("response_invalid", "The provider returned an empty answer.", {
        providerId: this.id,
        modelId: call.modelId,
      });
    }

    const usage = record(payload["usageMetadata"]);
    const inputTokens = numberValue(usage?.["promptTokenCount"]);
    const outputTokens = numberValue(usage?.["candidatesTokenCount"]);

    return {
      text,
      finishReason: finishReason(candidate?.["finishReason"]),
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : {
            usage: {
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens }),
              source: "provider" as const,
            },
          }),
    };
  }
}
