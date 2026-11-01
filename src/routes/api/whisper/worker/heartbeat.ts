import { createFileRoute } from "@tanstack/react-router";
import { authenticateApiUser } from "@/server/auth/api-user.server";
import { getWhisperAdmin, validWorkerToken } from "@/server/whisper/admin.server";
import { readJsonBody } from "@/server/storage/signed-upload.server";

export const Route = createFileRoute("/api/whisper/worker/heartbeat")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await authenticateApiUser(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
        const admin = getWhisperAdmin();
        if (!admin) return Response.json({ error: "queue_unconfigured" }, { status: 503 });
        const { data, error } = await admin
          .from("transcription_workers")
          .select("last_seen_at")
          .order("last_seen_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return Response.json({ error: "health_unavailable" }, { status: 503 });
        const online = Boolean(data && Date.now() - new Date(data.last_seen_at).getTime() < 90_000);
        return Response.json(
          { online, lastSeenAt: data?.last_seen_at ?? null },
          { headers: { "cache-control": "no-store" } },
        );
      },
      POST: async ({ request }) => {
        if (!validWorkerToken(request))
          return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await readJsonBody(request);
        const workerId =
          typeof body?.["workerId"] === "string" ? body["workerId"].slice(0, 120) : "";
        const allowedStates = new Set([
          "idle",
          "claimed",
          "downloading",
          "extracting_audio",
          "transcribing",
          "normalizing",
          "indexing",
        ]);
        const state = typeof body?.["state"] === "string" ? body["state"] : "idle";
        if (!workerId || !allowedStates.has(state))
          return Response.json({ error: "invalid_heartbeat" }, { status: 400 });
        const admin = getWhisperAdmin();
        if (!admin) return Response.json({ error: "queue_unconfigured" }, { status: 503 });
        const { error } = await admin.from("transcription_workers").upsert({
          worker_id: workerId,
          state,
          last_seen_at: new Date().toISOString(),
          metadata: { worker: "horizon-local-whisper" },
        });
        if (error) return Response.json({ error: "health_unavailable" }, { status: 503 });
        return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
