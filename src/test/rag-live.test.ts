import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { retrieveVideoEvidence, type RagLesson } from "@/server/rag/service.server";
import { answerLessonQuestion } from "@/server/ai/lesson-tutor.server";
import type { RagDatabase } from "@/server/rag/database";

/**
 * Live pgvector checks. No embedding is generated here: the query vector is an
 * existing passage's own vector, so this runs even when the Gemini embedding
 * daily quota is exhausted. It verifies the SQL position gate and RLS with real
 * signed-in clients.
 *
 * RUN_LIVE_RAG=1 npx vitest run src/test/rag-live.test.ts
 */
const configured = Boolean(
  process.env["RUN_LIVE_RAG"] === "1" &&
  process.env["SUPABASE_URL"] &&
  process.env["SUPABASE_PUBLISHABLE_KEY"] &&
  process.env["SUPABASE_PROJECT_ID"] &&
  process.env["SUPABASE_ACCESS_TOKEN"] &&
  process.env["E2E_TEST_EMAIL"] &&
  process.env["E2E_TEST_PASSWORD"],
);

async function learner(): Promise<{ client: SupabaseClient<Database>; userId: string }> {
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
  return { client, userId: data.user!.id };
}

async function admin(): Promise<SupabaseClient<Database>> {
  const project = process.env["SUPABASE_PROJECT_ID"]!;
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys`, {
    headers: { authorization: `Bearer ${process.env["SUPABASE_ACCESS_TOKEN"]!}` },
  });
  expect(response.ok).toBe(true);
  const keys = (await response.json()) as Array<{ name?: string; api_key?: string }>;
  const secret = keys.find((key) => key.name === "service_role")?.api_key;
  expect(secret).toBeTruthy();
  return createClient<Database>(process.env["SUPABASE_URL"]!, secret!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const MIT_LESSON = "mit-15-773-01";

describe.skipIf(!configured)("pgvector RAG", () => {
  it("uses similarity search but never returns chunks past the playhead", async () => {
    const { client } = await learner();
    const rag = client as unknown as SupabaseClient<RagDatabase>;
    const chunk = await rag
      .from("video_chunks")
      .select("id,start_seconds,end_seconds,embedding")
      .eq("lesson_id", MIT_LESSON)
      .order("chunk_index")
      .limit(1)
      .single();
    expect(chunk.error).toBeNull();
    const row = chunk.data!;

    const after = await rag.rpc("match_video_chunks", {
      query_embedding: row.embedding,
      target_lesson_id: MIT_LESSON,
      max_position_seconds: row.end_seconds + 1,
      match_count: 5,
    });
    expect(after.error).toBeNull();
    expect(after.data?.[0]?.id).toBe(row.id);
    for (const match of after.data ?? []) {
      expect(match.end_seconds).toBeLessThanOrEqual(row.end_seconds + 1);
      expect(match.lesson_id).toBe(MIT_LESSON);
    }

    const before = await rag.rpc("match_video_chunks", {
      query_embedding: row.embedding,
      target_lesson_id: MIT_LESSON,
      max_position_seconds: Math.max(0, row.start_seconds - 0.5),
      match_count: 5,
    });
    expect(before.error).toBeNull();
    expect(before.data).toEqual([]);
  });

  it("retrieves a chronological covered window through the central service", async () => {
    const { client } = await learner();
    const lesson = await client
      .from("lessons")
      .select("id,title,user_id,course_id,is_demo,duration_seconds,transcript")
      .eq("id", MIT_LESSON)
      .single();
    expect(lesson.error).toBeNull();
    const position = 600;
    const result = await retrieveVideoEvidence({
      supabase: client,
      lesson: lesson.data as RagLesson,
      positionSeconds: position,
      query: "key ideas",
      mode: "summary",
      limit: 6,
    });
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("summary");
    expect(result!.chunks.length).toBeGreaterThan(0);
    for (const chunk of result!.chunks) {
      expect(chunk.locator.kind).toBe("video");
      if (chunk.locator.kind === "video") {
        expect(chunk.locator.endSeconds).toBeLessThanOrEqual(position);
        expect(chunk.locator.lessonId).toBe(MIT_LESSON);
      }
    }
  });

  it.skipIf(process.env["RUN_LIVE_RAG_CHAT"] !== "1")(
    "summarizes through the pgvector window with bounded citations",
    async () => {
      const { client, userId } = await learner();
      const position = 600;
      const answer = await answerLessonQuestion({
        supabase: client,
        userId,
        lessonId: MIT_LESSON,
        positionSeconds: position,
        question: "Summarize the key ideas covered so far.",
        mode: "summary",
      });
      console.log(
        `[rag summary] ${answer.status} ${JSON.stringify(
          answer.status === "answered"
            ? { retrieval: answer.retrieval, citations: answer.citations.length }
            : answer,
        ).slice(0, 500)}`,
      );
      expect(answer.status).toBe("answered");
      if (answer.status !== "answered") return;
      expect(answer.retrieval).toBe("summary");
      expect(answer.citations.length).toBeGreaterThan(0);
      for (const citation of answer.citations) {
        if (citation.locator.kind === "video") {
          expect(citation.locator.endSeconds).toBeLessThanOrEqual(position);
        }
      }
    },
    120_000,
  );

  it("never exposes a private lesson's chunks to another learner", async () => {
    const { client, userId } = await learner();
    const service = await admin();
    const ragService = service as unknown as SupabaseClient<RagDatabase>;
    const lessonId = `rag-isolation-${randomUUID()}`;
    const secondEmail = `rag-isolation-${randomUUID()}@example.com`;
    const secondPassword = `Rag-${randomUUID()}-9x`;
    let secondUserId: string | undefined;

    try {
      const source = await client
        .from("lessons")
        .select("id,title,user_id,course_id,is_demo,duration_seconds,transcript")
        .eq("id", MIT_LESSON)
        .single();
      expect(source.error).toBeNull();
      const sourceLesson = source.data as RagLesson;

      const inserted = await service.from("lessons").insert({
        id: lessonId,
        user_id: userId,
        title: "RAG isolation check",
        description: "Temporary lesson created by the live RAG test.",
        video_url: "https://example.com/rag-isolation.mp4",
        provider: "direct",
        transcript_status: "available",
        duration_seconds: sourceLesson.duration_seconds,
        transcript: sourceLesson.transcript as never,
      });
      expect(inserted.error).toBeNull();

      const sourceChunks = await ragService
        .from("video_chunks")
        .select(
          "chunk_index,text,start_seconds,end_seconds,embedding,embedding_provider,embedding_model,embedding_dimension,embedding_space_key,content_hash,metadata",
        )
        .eq("lesson_id", MIT_LESSON)
        .order("chunk_index")
        .limit(6);
      expect(sourceChunks.error).toBeNull();
      expect(sourceChunks.data?.length).toBe(6);
      const copied = await ragService.from("video_chunks").insert(
        (sourceChunks.data ?? []).map((chunk) => ({
          lesson_id: lessonId,
          chunk_index: chunk.chunk_index,
          text: chunk.text,
          start_seconds: chunk.start_seconds,
          end_seconds: chunk.end_seconds,
          embedding: chunk.embedding,
          embedding_provider: chunk.embedding_provider,
          embedding_model: chunk.embedding_model,
          embedding_dimension: chunk.embedding_dimension,
          embedding_space_key: chunk.embedding_space_key,
          content_hash: chunk.content_hash,
          metadata: chunk.metadata,
        })),
      );
      expect(copied.error).toBeNull();
      const index = await ragService.from("video_indexes").upsert(
        {
          lesson_id: lessonId,
          status: "ready",
          chunk_count: 6,
          embedding_provider: "gemini",
          embedding_model: "gemini-embedding-001",
          embedding_dimension: 768,
          embedding_space_key: sourceChunks.data![0]!.embedding_space_key,
        },
        { onConflict: "lesson_id" },
      );
      expect(index.error).toBeNull();

      const queryVector = sourceChunks.data![0]!.embedding;
      const ownerResult = await (client as unknown as SupabaseClient<RagDatabase>).rpc(
        "match_video_chunks",
        {
          query_embedding: queryVector,
          target_lesson_id: lessonId,
          max_position_seconds: sourceLesson.duration_seconds,
          match_count: 5,
        },
      );
      expect(ownerResult.error).toBeNull();
      expect(ownerResult.data?.length).toBeGreaterThan(0);

      const anonymous = createClient<Database>(
        process.env["SUPABASE_URL"]!,
        process.env["SUPABASE_PUBLISHABLE_KEY"]!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const anonymousResult = await (anonymous as unknown as SupabaseClient<RagDatabase>).rpc(
        "match_video_chunks",
        {
          query_embedding: queryVector,
          target_lesson_id: lessonId,
          max_position_seconds: sourceLesson.duration_seconds,
          match_count: 5,
        },
      );
      // Unauthenticated callers may not execute the retrieval function at all.
      expect(anonymousResult.error?.code).toBe("42501");
      expect(anonymousResult.data).toBeNull();

      const created = await service.auth.admin.createUser({
        email: secondEmail,
        password: secondPassword,
        email_confirm: true,
      });
      expect(created.error).toBeNull();
      secondUserId = created.data.user?.id;
      const second = createClient<Database>(
        process.env["SUPABASE_URL"]!,
        process.env["SUPABASE_PUBLISHABLE_KEY"]!,
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const signedIn = await second.auth.signInWithPassword({
        email: secondEmail,
        password: secondPassword,
      });
      expect(signedIn.error).toBeNull();
      const secondResult = await (second as unknown as SupabaseClient<RagDatabase>).rpc(
        "match_video_chunks",
        {
          query_embedding: queryVector,
          target_lesson_id: lessonId,
          max_position_seconds: sourceLesson.duration_seconds,
          match_count: 5,
        },
      );
      expect(secondResult.error).toBeNull();
      expect(secondResult.data).toEqual([]);
    } finally {
      await service.from("lessons").delete().eq("id", lessonId);
      if (secondUserId) await service.auth.admin.deleteUser(secondUserId);
    }
  }, 120_000);
});
