import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { indexLessonVideo } from "@/server/rag/service.server";
import type { RagLesson } from "@/server/rag/service.server";
import type { RagDatabase } from "@/server/rag/database";

/**
 * One-off migration for the preloaded MIT lessons (and any other transcript
 * already in the database). It is a live, opt-in operation because it spends
 * Gemini embedding quota. The service-role key is fetched from the Management
 * API in memory and is never printed or written to disk.
 *
 * RUN_LIVE_RAG_INDEX=1 npx vitest run src/test/rag-backfill.live.test.ts
 */
const configured = Boolean(
  process.env["RUN_LIVE_RAG_INDEX"] === "1" &&
  process.env["SUPABASE_URL"] &&
  process.env["SUPABASE_PROJECT_ID"] &&
  process.env["SUPABASE_ACCESS_TOKEN"] &&
  process.env["GEMINI_API_KEY"],
);

async function adminClient(): Promise<SupabaseClient<Database>> {
  const project = process.env["SUPABASE_PROJECT_ID"]!;
  const token = process.env["SUPABASE_ACCESS_TOKEN"]!;
  const response = await fetch(`https://api.supabase.com/v1/projects/${project}/api-keys`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.ok).toBe(true);
  const keys = (await response.json()) as Array<{ name?: string; api_key?: string }>;
  const secret = keys.find((key) => key.name === "service_role")?.api_key;
  expect(secret).toBeTruthy();
  return createClient<Database>(process.env["SUPABASE_URL"]!, secret!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe.skipIf(!configured)("pgvector backfill", () => {
  it("indexes every transcript-backed lesson", async () => {
    const admin = await adminClient();
    const ragAdmin = admin as unknown as SupabaseClient<RagDatabase>;
    const lessons = await admin
      .from("lessons")
      .select("id,title,user_id,course_id,is_demo,duration_seconds,transcript,transcript_status")
      .eq("transcript_status", "available")
      .order("id");
    expect(lessons.error).toBeNull();
    const rows = lessons.data ?? [];
    expect(rows.length).toBeGreaterThan(10);

    const failures: string[] = [];
    for (const row of rows) {
      if (!Array.isArray(row.transcript) || row.transcript.length === 0) continue;
      const result = await indexLessonVideo({
        supabase: admin,
        lesson: row as RagLesson,
      });
      console.log(
        `[rag] ${row.id} ${result.status} chunks=${result.chunks}${result.error ? ` error=${result.error}` : ""}`,
      );
      if (result.status !== "ready") failures.push(`${row.id}:${result.error ?? "unknown"}`);
    }
    expect(failures).toEqual([]);

    const counts = await ragAdmin
      .from("video_chunks")
      .select("lesson_id", { count: "exact", head: true });
    expect(counts.error).toBeNull();
    expect(counts.count ?? 0).toBeGreaterThan(100);

    const statuses = await ragAdmin
      .from("video_indexes")
      .select("lesson_id,status,chunk_count")
      .eq("status", "ready");
    expect(statuses.error).toBeNull();
    expect((statuses.data ?? []).length).toBeGreaterThanOrEqual(rows.length - 2);
  }, 900_000);
});
