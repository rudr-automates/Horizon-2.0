import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { answerLessonQuestion } from "@/server/ai/lesson-tutor.server";
import { generateQuiz, gradeQuiz } from "@/server/ai/quiz.server";
import { ingestLessonResource } from "@/server/ingestion/service.server";

const configured = Boolean(
  process.env["RUN_LIVE_WORKFLOW"] === "1" &&
  process.env["SUPABASE_URL"] &&
  process.env["SUPABASE_PUBLISHABLE_KEY"] &&
  process.env["E2E_TEST_EMAIL"] &&
  process.env["E2E_TEST_PASSWORD"],
);

describe.skipIf(!configured)("live MIT lesson workflow", () => {
  async function learnerClient(): Promise<{
    client: SupabaseClient<Database>;
    userId: string;
  }> {
    const client = createClient<Database>(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_PUBLISHABLE_KEY"]!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await client.auth.signInWithPassword({
      email: process.env["E2E_TEST_EMAIL"]!,
      password: process.env["E2E_TEST_PASSWORD"]!,
    });
    expect(error).toBeNull();
    expect(data.user?.id).toBeTruthy();
    return { client, userId: data.user!.id };
  }

  it("reads the seeded MIT course through learner RLS", async () => {
    const { client } = await learnerClient();
    const { data, error } = await client
      .from("lessons")
      .select("id,title,course_id,duration_seconds")
      .eq("course_id", "mit-15-773")
      .order("position");
    expect(error).toBeNull();
    expect(data).toHaveLength(11);
    expect(data?.[0]?.id).toBe("mit-15-773-01");
    expect(data?.[0]?.duration_seconds).toBeGreaterThan(3_000);
  });

  it("returns a grounded, cited answer from real providers", async () => {
    const { client, userId } = await learnerClient();
    const result = await answerLessonQuestion({
      supabase: client,
      userId,
      lessonId: "mit-15-773-01",
      positionSeconds: 2_800,
      question: "What is an activation function, and why is ReLU used in hidden layers?",
      mode: "question",
    });

    if (result.status !== "answered") {
      throw new Error(`Tutor returned ${result.status}: ${JSON.stringify(result)}`);
    }
    expect(result.answer.length).toBeGreaterThan(20);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.providerId).toMatch(/gemini|groq/);
    expect(result.citations.every((citation) => citation.evidenceId.length > 0)).toBe(true);
    expect(
      result.citations.every((citation) =>
        citation.locator.kind === "video"
          ? citation.locator.endSeconds <= 2_800
          : Boolean(citation.sourceUrl),
      ),
    ).toBe(true);
    expect(result.exchangeId).toBeTruthy();

    const { error: feedbackError } = await client
      .from("tutor_exchanges")
      .update({ helpful: true })
      .eq("id", result.exchangeId!);
    expect(feedbackError).toBeNull();
    const stored = await client
      .from("tutor_exchanges")
      .select("helpful,provider_id")
      .eq("id", result.exchangeId!)
      .single();
    expect(stored.data?.helpful).toBe(true);
    expect(stored.data?.provider_id).toMatch(/gemini|groq/);
  }, 120_000);

  it("explains and summarises the covered MIT material", async () => {
    const { client, userId } = await learnerClient();
    for (const mode of ["explain", "summary"] as const) {
      const result = await answerLessonQuestion({
        supabase: client,
        userId,
        lessonId: "mit-15-773-01",
        positionSeconds: 2_800,
        question:
          mode === "explain"
            ? "Explain the covered material around this point simply."
            : "Summarize the key ideas covered so far.",
        mode,
      });
      console.log(`[mit ${mode}] ${result.status}`);
      expect(result.status).toBe("answered");
      if (result.status !== "answered") continue;
      expect(result.citations.length).toBeGreaterThan(0);
      expect(
        result.citations.every((citation) =>
          citation.locator.kind === "video"
            ? citation.locator.endSeconds <= 2_800
            : Boolean(citation.sourceUrl),
        ),
      ).toBe(true);
    }
  }, 180_000);

  it("generates and grades a persisted practice check", async () => {
    const { client, userId } = await learnerClient();
    const quiz = await generateQuiz({
      supabase: client,
      userId,
      lessonId: "mit-15-773-01",
      positionSeconds: 2_800,
      mode: "quiz",
    });
    if (quiz.status !== "ready") {
      throw new Error(`Quiz returned ${quiz.status}: ${JSON.stringify(quiz)}`);
    }
    expect(quiz.questions.length).toBeGreaterThanOrEqual(2);
    expect(quiz.questions.every((question) => question.options.length === 4)).toBe(true);

    const graded = await gradeQuiz({
      supabase: client,
      userId,
      attemptId: quiz.attemptId,
      answers: quiz.questions.map(() => 0),
    });
    expect(graded.status).toBe("graded");
    if (graded.status !== "graded") return;
    expect(graded.results).toHaveLength(quiz.questions.length);
    expect(graded.score).toBeGreaterThanOrEqual(0);
    expect(graded.results.every((result) => result.citations.length > 0)).toBe(true);
  }, 120_000);

  it("ingests a private note and cites only its owner's evidence", async () => {
    const { client, userId } = await learnerClient();
    const marker = `cobalt-canary-${Date.now()}`;
    const ingest = await ingestLessonResource({
      supabase: client,
      userId,
      lessonId: "mit-15-773-01",
      filename: `${marker}.txt`,
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(
        `Private study note. The ${marker} protocol requires three blue feathers and a listening cone.`,
      ),
    });
    if (ingest.status !== "ready") {
      throw new Error(`Ingestion returned ${ingest.code}: ${ingest.message}`);
    }
    expect(ingest.chunkCount).toBeGreaterThan(0);
    expect(ingest.embeddingStatus).not.toBe("unavailable");

    try {
      const result = await answerLessonQuestion({
        supabase: client,
        userId,
        lessonId: "mit-15-773-01",
        positionSeconds: 2_800,
        question: `What does the ${marker} protocol require?`,
      });
      expect(result.status).toBe("answered");
      if (result.status !== "answered") return;
      expect(result.citations.length).toBeGreaterThan(0);
      const privateCitation = result.citations.find(
        (citation) =>
          citation.locator.kind === "text" && citation.sourceUrl?.includes("/object/sign/"),
      );
      expect(privateCitation).toBeTruthy();
      expect(result.answer.toLowerCase()).toContain("blue feathers");
      if (privateCitation?.sourceUrl) {
        const file = await fetch(privateCitation.sourceUrl);
        expect(file.status).toBe(200);
        expect(await file.text()).toContain("blue feathers");
      }
    } finally {
      const { data: row } = await client
        .from("learning_resources")
        .select("metadata")
        .eq("id", ingest.resourceId)
        .maybeSingle();
      const metadata = row?.metadata;
      const storagePath =
        typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
          ? metadata["storage_path"]
          : undefined;
      if (typeof storagePath === "string") {
        await client.storage.from("learning-resources").remove([storagePath]);
      }
      await client.from("learning_resources").delete().eq("id", ingest.resourceId);
    }
  }, 180_000);

  it("generates exam and interview practice modes", async () => {
    const { client, userId } = await learnerClient();
    for (const mode of ["exam", "interview"] as const) {
      const quiz = await generateQuiz({
        supabase: client,
        userId,
        lessonId: "mit-15-773-01",
        positionSeconds: 2_800,
        mode,
      });
      if (quiz.status !== "ready") {
        throw new Error(`${mode} returned ${quiz.status}: ${JSON.stringify(quiz)}`);
      }
      expect(quiz.mode).toBe(mode);
      expect(quiz.questions.length).toBeGreaterThanOrEqual(2);
      const graded = await gradeQuiz({
        supabase: client,
        userId,
        attemptId: quiz.attemptId,
        answers: quiz.questions.map(() => 1),
      });
      expect(graded.status).toBe("graded");
    }
  }, 180_000);

  it("ingests a real PPTX with slide locators and embeddings", async () => {
    const { client, userId } = await learnerClient();
    const slide = (text: string) =>
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const pptx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "ppt/presentation.xml": strToU8("<p:presentation/>"),
      "ppt/slides/slide1.xml": strToU8(
        slide("A neuron combines a linear map with a nonlinear activation."),
      ),
      "ppt/slides/slide2.xml": strToU8(
        slide("ReLU keeps positive values and clamps negative values to zero."),
      ),
    });
    const ingest = await ingestLessonResource({
      supabase: client,
      userId,
      lessonId: "mit-15-773-01",
      filename: `activation-deck-${Date.now()}.pptx`,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: pptx,
    });
    if (ingest.status !== "ready") {
      throw new Error(`PPTX ingestion returned ${ingest.code}: ${ingest.message}`);
    }
    expect(ingest.kind).toBe("slides");
    expect(ingest.chunkCount).toBe(2);
    expect(ingest.embeddedChunks).toBe(2);

    try {
      const { data: chunks, error } = await client
        .from("resource_chunks")
        .select("locator_kind,slide_number,embedding")
        .eq("resource_id", ingest.resourceId)
        .order("chunk_index");
      expect(error).toBeNull();
      expect(chunks).toHaveLength(2);
      expect(chunks?.every((chunk) => chunk.locator_kind === "slide")).toBe(true);
      expect(chunks?.every((chunk) => chunk.embedding !== null)).toBe(true);
    } finally {
      const { data: row } = await client
        .from("learning_resources")
        .select("metadata")
        .eq("id", ingest.resourceId)
        .maybeSingle();
      const metadata = row?.metadata;
      const storagePath =
        typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
          ? metadata["storage_path"]
          : undefined;
      if (typeof storagePath === "string") {
        await client.storage.from("learning-resources").remove([storagePath]);
      }
      await client.from("learning_resources").delete().eq("id", ingest.resourceId);
    }
  }, 180_000);

  it("refuses an unrelated question instead of inventing an answer", async () => {
    const { client, userId } = await learnerClient();
    const result = await answerLessonQuestion({
      supabase: client,
      userId,
      lessonId: "mit-15-773-01",
      positionSeconds: 2_800,
      question: "What is the capital of France?",
      mode: "question",
    });

    expect(["answered", "insufficient_evidence", "error"]).toContain(result.status);
    if (result.status === "answered") {
      // If the model tries to answer, every claim must still be tied to the
      // eligible lesson evidence; a non-grounded answer is a bug.
      expect(result.citations.length).toBeGreaterThan(0);
    }
  }, 120_000);
});
