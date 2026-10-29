import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { JinaEmbeddingProvider } from "@/server/ai/embeddings/jina";
import { JinaReranker } from "@/server/retrieval/rerank";
import { answerLessonQuestion } from "@/server/ai/lesson-tutor.server";
import { GeminiProvider } from "@/server/ai/providers/gemini";
import { GroqProvider } from "@/server/ai/providers/groq";
import { getAiRuntime } from "@/server/ai/runtime.server";

const hasKeys = Boolean(
  process.env["GEMINI_API_KEY"] && process.env["GROQ_API_KEY"] && process.env["JINA_API_KEY"],
);

function demoClient(): SupabaseClient<Database> {
  const lesson: Database["public"]["Tables"]["lessons"]["Row"] = {
    id: "embeddings",
    course_id: "understanding-rag",
    user_id: null,
    title: "Meaning in numbers",
    description: "Embeddings, cosine similarity, and why relevance is not certainty.",
    position: 1,
    duration_seconds: 56.2,
    video_url: "/sample/embeddings.webm",
    provider: "direct",
    transcript_status: "available",
    is_demo: true,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    transcript: [
      {
        start: 0,
        end: 15.76,
        heading: "What is an embedding?",
        text: "An embedding is a list of numbers that represents a piece of content. A trained model maps related meanings to nearby positions in a vector space.",
      },
      {
        start: 15.76,
        end: 36.72,
        heading: "Similarity, not certainty",
        text: "Embeddings can place related phrases near each other. Cosine similarity measures how closely two vectors point in the same direction. It is a similarity score, not a probability of correctness.",
      },
      {
        start: 36.72,
        end: 56.2,
        heading: "A consistent vector space",
        text: "Encode the query and documents with the same compatible embedding model, then rank candidate passages. An embedding does not verify a fact.",
      },
    ],
  };
  function emptyResources() {
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      in: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return query;
  }
  return {
    from: (table: string) =>
      table === "lessons"
        ? ({
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: lesson, error: null }) }),
            }),
          } as unknown)
        : (emptyResources() as unknown),
  } as unknown as SupabaseClient<Database>;
}

describe.skipIf(!hasKeys || process.env["RUN_REAL_AI_SMOKE"] !== "1")("real provider smoke", () => {
  it("answers through Gemini with JSON mode", async () => {
    const provider = new GeminiProvider(process.env);
    const result = await provider.complete({
      modelId: "gemini-3.5-flash-lite",
      messages: [
        { role: "system", content: 'Return JSON exactly as {"ok":true}' },
        { role: "user", content: "Return the JSON." },
      ],
      maxOutputTokens: 64,
      temperature: 0,
      responseFormat: "json",
      signal: new AbortController().signal,
      correlationId: "smoke-gemini",
    });
    expect(result.text).toContain("ok");
  });

  it("answers through Groq with JSON mode", async () => {
    const provider = new GroqProvider(process.env);
    const result = await provider.complete({
      modelId: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: 'Return JSON exactly as {"ok":true}' },
        { role: "user", content: "Return the JSON." },
      ],
      maxOutputTokens: 256,
      temperature: 0,
      responseFormat: "json",
      signal: new AbortController().signal,
      correlationId: "smoke-groq",
    });
    expect(result.text).toContain("ok");
  });

  it("returns a 1024-dimension Jina embedding", async () => {
    const provider = new JinaEmbeddingProvider(process.env);
    const model = provider.models[0];
    expect(model).toBeDefined();
    if (!model) return;
    const result = await provider.embed(["A grounded answer needs evidence."], model, {
      correlationId: "smoke-jina",
      purpose: "query",
    });
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(1_024);
  });

  it("reranks candidates through Jina", async () => {
    const reranker = new JinaReranker(process.env);
    const rows = await reranker.rerank("Why is a non-linear activation function needed?", [
      {
        id: "activation",
        text: "A non-linear activation function lets a network represent relationships beyond a straight line.",
      },
      { id: "weather", text: "The weather in Paris is mild in spring." },
      {
        id: "neurons",
        text: "A neuron applies a linear function followed by a non-linear activation.",
      },
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.id).not.toBe("weather");
  });

  it("uses the runtime gateway with the configured free model", async () => {
    const runtime = getAiRuntime(process.env);
    const result = await runtime.gateway.generate({
      messages: [
        { role: "system", content: 'Return JSON exactly as {"ok":true}' },
        { role: "user", content: "Return the JSON." },
      ],
      maxOutputTokens: 128,
      temperature: 0,
      responseFormat: "json",
    });
    expect(result.text).toContain("ok");
    expect(result.providerId).toBe("gemini");
  });

  it("answers a lesson question with verified citations and excludes future video", async () => {
    const result = await answerLessonQuestion({
      supabase: demoClient(),
      userId: "00000000-0000-4000-8000-000000000001",
      lessonId: "embeddings",
      positionSeconds: 20,
      question: "What is an embedding?",
      mode: "question",
    });

    expect(result.status).toBe("answered");
    if (result.status !== "answered") return;
    expect(result.answer.length).toBeGreaterThan(20);
    expect(result.citations.length).toBeGreaterThan(0);
    for (const citation of result.citations) {
      expect(citation.locator.kind).toBe("video");
      if (citation.locator.kind === "video") {
        expect(citation.locator.endSeconds).toBeLessThanOrEqual(20);
      }
    }
    expect(result.providerId).toBe("gemini");
  });

  it("refuses when no video material has been viewed yet", async () => {
    const result = await answerLessonQuestion({
      supabase: demoClient(),
      userId: "00000000-0000-4000-8000-000000000001",
      lessonId: "embeddings",
      positionSeconds: 0,
      question: "What is an embedding?",
    });
    expect(result.status).toBe("insufficient_evidence");
    if (result.status !== "insufficient_evidence") return;
    expect(result.reason).toBe("no_eligible_evidence");
  });
});
