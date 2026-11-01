# Universal video ingestion

Every video added to Horizon can ground the tutor, **Explain simply**,
**Summarize so far** and practice quizzes at the learner's current timestamp —
not only the seeded MIT course.

## Root cause

The four features never failed because of a retrieval bug. They failed because
a newly added video never entered the evidence pipeline:

1. **The demo course was pre-indexed offline.** `scripts/ingest-mit-course.mjs`
   writes `lessons.transcript`, one `learning_resources` row per lecture and
   embedded `resource_chunks` (26 resources in the connected project). This is
   why the MIT lectures answered immediately: ingestion had already happened,
   outside the application.
2. **A pasted link wrote only a `lessons` row.** `ImportVideo` inserted
   `title`, `video_url` and `provider`. No transcript, no chunks, no embeddings,
   and no processing was requested. The two learner lessons in the project
   ("Ellipse", "Test") were in exactly this state:
   `transcript_status = "unavailable"`, zero `learning_resources`.
3. **An uploaded file depended on an external desktop worker.**
   `/api/videos/upload` inserted the lesson with `transcript_status:
"unavailable"` and then the browser called `/api/whisper/jobs`. That route
   needs `SUPABASE_SERVICE_ROLE_KEY` and the `transcription_jobs` table, and the
   only worker that ever claims from it is `worker/whisper_worker.py`, a local
   Python process. In the connected project neither the table nor the worker was
   present, so the request failed and nothing was transcribed.
4. **The tutor then reported the wrong symptom.** With no evidence,
   `selectEligibleEvidence` returned an empty list and the server rendered
   "Nothing you have reached in this lesson is available as evidence yet" — a
   position message for a video that had no index at all.

## What the pipeline does now

`src/server/ingestion/video-pipeline.server.ts` drives a durable, resumable job
for the lesson's current video:

1. **Resolve the source.** `storage://lesson-videos/...` (private upload),
   a direct `https` MP4/WebM link, or a YouTube/Vimeo link.
2. **Acquire the media.** Private uploads are streamed from Supabase Storage
   through short-lived signed URLs in 8 MiB ranged reads; direct links are read
   the same way with public-host, scheme, content-type and size checks. Nothing
   is buffered whole.
3. **Transcribe.** The media is uploaded to the existing Gemini credential's
   Files API (resumable, 8 MiB chunks) and transcribed with a JSON-schema
   `generateContent` request that returns start/end seconds per passage.
   No audio-extraction binary, no new provider and no new secret are introduced.
   YouTube/Vimeo links use the host's published caption track instead.
4. **Preserve timestamps and chunk.** Provider segments are normalised (ordered,
   non-overlapping, text-only) and grouped into cue-sized passages that stay
   inside the existing 220-passage ingestion limit, then rendered as WebVTT.
5. **Embed and store through the existing ingestion service.**
   `ingestLessonResource` performs the same chunking, Jina embedding and
   `learning_resources`/`resource_chunks` writes used by uploaded notes, and
   syncs `lessons.transcript` so the Transcript panel matches.
6. **Retrieval is unchanged.** Evidence remains lesson-scoped, owner-scoped and
   end-time gated, so only material the learner has already reached is
   retrievable.

### Processing states

The UI and the AI features share one state model:

| State                   | Meaning                                                        | Behaviour                                                                          |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `none`                  | No job and no indexed transcript                               | "Not processed", a job is started when the lesson opens                            |
| `queued` / `processing` | Media upload, transcription or indexing in progress            | Progress strip in the Transcript tab; the tutor/quiz return `status: "processing"` |
| `ready`                 | Transcript, chunks and embeddings stored                       | All four features work                                                             |
| `needs_captions`        | Host published no readable captions, or no speech was detected | Actionable message: upload the file, paste captions, or retry                      |
| `failed`                | Provider/processing failure after bounded retries              | Error message and a retry button; never marked ready                               |

## Files

- `supabase/migrations/20261101120000_video_ingestion_jobs.sql` — additive
  `video_ingestion_jobs` table with owner-only RLS (no existing table, policy or
  workflow is changed).
- `src/server/ingestion/video-pipeline.server.ts` — source resolution, state
  machine, media readers, indexing hand-off.
- `src/server/ingestion/readiness.server.ts` — explains why a lesson has no
  transcript yet, shared by the tutor and the quiz generator.
- `src/server/ai/transcription/gemini.server.ts` — Files API upload, timestamped
  transcription, segment normalisation and WebVTT rendering.
- `src/routes/api/videos/process.ts` — authenticated `GET` status and `POST`
  bounded step.
- `src/hooks/use-video-ingestion.ts` — drives the job while a lesson page is
  open and refreshes the lesson when it becomes ready.
- `src/lib/ingestion-types.ts` — shared state types.
- `src/components/learning/{studio,transcript-panel,lesson-tutor,import-video}.tsx`
  — status display, retry, and processing messages. The design system is
  unchanged.
- `src/server/ai/{lesson-tutor,quiz}.server.ts` — return a processing state
  instead of an evidence refusal when the lesson has no index yet.
- `src/lib/tutor-types.ts` — adds the `processing` response variant.

## Migrations and configuration

Applied to the connected project:

- `20261031235217_whisper_transcription_jobs.sql` (the optional desktop queue
  that was in the repository but missing from the database).
- `20261101120000_video_ingestion_jobs.sql` (new).

Both are additive. Apply them with the Supabase CLI or the SQL editor; regenerate
`src/integrations/supabase/types.ts` afterwards.

No new required environment variable was added. The pipeline reuses
`GEMINI_API_KEY`. Optional:

| Variable                                            | Default            | Purpose                                                                         |
| --------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `VIDEO_TRANSCRIPTION_MODEL`                         | `gemini-3.5-flash` | Override the timestamped transcription model.                                   |
| `SUPABASE_SERVICE_ROLE_KEY`, `WHISPER_WORKER_TOKEN` | unset              | Only for the optional local Whisper queue; the new pipeline does not need them. |

## Verification

Deterministic suite: `npm test` (113 passing, 16 opt-in/skipped, including 8 new
pipeline tests), `npx tsc --noEmit` and `npm run build` all pass.

Live checks performed against the connected project with a temporary learner and
a generated 90-second spoken MP4:

1. The MIT lesson still returns a grounded, cited answer, Explain simply and
   Summarize so far (`RUN_LIVE_WORKFLOW=1`, run in isolation to stay inside the
   free-tier per-minute guard).
2. A new upload reaches `ready` automatically: one `video_transcript` resource
   with 5 embedded, timestamped passages (`RUN_LIVE_VIDEO_PIPELINE=1`).
3. Ask the tutor: answered with a timestamped citation and `hybrid` retrieval.
4. Explain simply: answered with a citation from the covered material.
5. Summarize so far: answered with 5 citations.
6. Quiz generation: `ready` with questions generated from the new video.
7. Position 5 s: `insufficient_evidence` with zero eligible passages, so no
   future content can be cited; position at the end reaches all passages.
8. Every video citation resolved to the new lesson id — no cross-video leakage.

## Limitations

- **YouTube/Vimeo links** are transcribed only when the host publishes a caption
  track the server can read. YouTube currently gates caption downloads for
  server-side clients, and the Gemini API rejected public YouTube URLs for this
  project (`INTERNAL`), so a link that cannot be read is reported as
  `needs_captions` with instructions. Uploading the MP4/WebM removes the
  dependency on the host.
- **Processing advances while a lesson page is open.** The server performs one
  bounded step per authenticated request, which keeps it safe on serverless
  runtimes; progress is durable, so reopening the lesson resumes where it
  stopped. A cron/queue runner would make it fully headless.
- **Free-tier quotas.** Provider 429s are retried with the provider's own retry
  delay, up to five attempts. A video whose job exhausts them is marked `failed`
  with a retry action; it is never marked ready. The application also caps free
  AI usage (8 requests/minute per model, 12 globally, 150/day per model), so a
  rapid burst of live requests can return `application_limit_exceeded` even
  though the pipeline is healthy.
- **Answer verification is strict.** The tutor withholds an answer when any
  sentence cannot be entailed by its cited evidence. It now asks the model once
  to restate the answer conservatively; if that still fails, the answer is
  withheld rather than shown ungrounded.
- **Long recordings** are transcribed in one provider request. Very long media
  may hit provider output limits or request time limits on serverless hosts; the
  job reports that instead of silently truncating evidence.
