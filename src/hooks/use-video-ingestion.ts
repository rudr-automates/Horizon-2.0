import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { isIngestionActive, type IngestionStatus } from "@/lib/ingestion-types";

interface UseVideoIngestionOptions {
  lessonId: string;
  /** Demo lessons are indexed already and must not create processing jobs. */
  enabled: boolean;
  /** Called when processing reaches `ready`, to refresh the lesson row. */
  onReady?: () => void;
}

interface ApiPayload {
  status?: string;
  message?: string;
  ingestion?: IngestionStatus;
}

async function call(
  lessonId: string,
  method: "GET" | "POST",
  retry: boolean,
): Promise<IngestionStatus> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in again to check video processing.");
  const url =
    method === "GET"
      ? `/api/videos/process?lessonId=${encodeURIComponent(lessonId)}`
      : "/api/videos/process";
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ lessonId, retry }) } : {}),
  });
  const payload = (await response.json().catch(() => null)) as ApiPayload | null;
  if (!response.ok || payload?.status !== "ok" || !payload.ingestion) {
    throw new Error(payload?.message ?? "Processing status is unavailable.");
  }
  return payload.ingestion;
}

/**
 * Drives the automatic video pipeline from the browser.
 *
 * The server performs one bounded step per request, so the page advances the
 * job while it is open: media upload chunks, provider polling, then chunking and
 * embedding. Every state (queued, processing, ready, needs captions, failed) is
 * surfaced to the UI instead of being hidden behind an evidence error.
 */
export function useVideoIngestion({ lessonId, enabled, onReady }: UseVideoIngestionOptions) {
  const [status, setStatus] = useState<IngestionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const running = useRef(false);
  const announcedReady = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const advance = useCallback(
    async (retry: boolean) => {
      if (!enabled || running.current) return;
      running.current = true;
      clearTimer();
      if (retry) setBusy(true);
      try {
        const next = await call(lessonId, "POST", retry);
        if (!alive.current) return;
        setStatus(next);
        setError(null);
        if (next.state === "ready") {
          if (!announcedReady.current) {
            announcedReady.current = true;
            onReadyRef.current?.();
          }
          return;
        }
        if (isIngestionActive(next.state) || next.state === "none") {
          timer.current = setTimeout(() => {
            running.current = false;
            void advance(false);
          }, next.pollAfterMs ?? 2_000);
        }
      } catch (caught) {
        if (alive.current) {
          setError(caught instanceof Error ? caught.message : "Processing status is unavailable.");
        }
      } finally {
        running.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [clearTimer, enabled, lessonId],
  );

  useEffect(() => {
    alive.current = true;
    announcedReady.current = false;
    if (!enabled) {
      setStatus(null);
      setError(null);
      return () => {
        alive.current = false;
        clearTimer();
      };
    }
    let cancelled = false;
    void (async () => {
      try {
        const first = await call(lessonId, "GET", false);
        if (cancelled || !alive.current) return;
        setStatus(first);
        if (first.state === "ready") {
          announcedReady.current = true;
          onReadyRef.current?.();
          return;
        }
        if (first.state === "none" || isIngestionActive(first.state)) {
          await advance(false);
        }
      } catch (caught) {
        if (!cancelled && alive.current) {
          setError(caught instanceof Error ? caught.message : "Processing status is unavailable.");
        }
      }
    })();
    return () => {
      cancelled = true;
      alive.current = false;
      clearTimer();
    };
  }, [advance, clearTimer, enabled, lessonId]);

  const retry = useCallback(async () => {
    announcedReady.current = false;
    await advance(true);
  }, [advance]);

  return { status, error, busy, retry };
}
