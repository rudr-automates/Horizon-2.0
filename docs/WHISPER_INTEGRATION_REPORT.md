# Horizon Whisper integration review report

**Review branch:** `codex/horizon-final-rebuild`

**Scope:** local Windows `whisper.cpp` worker integrated with Horizon's private video uploads and existing timestamped transcript ingestion.

## Implemented

- Added `transcription_jobs` with owner-only read RLS, bounded retries, leases, heartbeats, progress and an atomic `SKIP LOCKED` claim function. Database serialization permits one active GPU job globally.
- Added learner enqueue/status and worker claim/heartbeat/result/failure routes. Worker routes require a separate bearer secret and fresh per-job lease token. Claim returns a 10-minute signed URL for the exact private `lesson-videos` object.
- Added an idle/active PC worker heartbeat and a learner-facing online indicator; expired job leases are retried and the database limits work to one active GPU job.
- Added server-only service-role client use. No credentials are placed in browser code.
- Private MP4/WebM uploads automatically request transcription; the Transcript tab reports job state and permits retry. Linked videos remain on the manual-caption path.
- Added the Windows Python worker. It uses configurable absolute paths, verifies the model checksum and CLI startup, normalizes audio with FFmpeg, captures logs, rejects unconfirmed Vulkan unless explicit CPU fallback is enabled, parses actual `transcription[]` JSON, validates ordered segment timestamps, and cleans temporary media/audio.
- Successful worker output is passed through Horizon's existing ingestion service, embeddings, chunking, retrieval and transcript-panel sync. Existing tutor, quiz, temporal eligibility and citation code was not replaced.
- Added worker setup documentation and placeholder-only configuration.

## Verification performed

- `corepack pnpm exec tsc --noEmit`: passed.
- `corepack pnpm build`: passed.
- `corepack pnpm lint`: passed with 8 existing React Fast Refresh warnings; no lint errors.
- `corepack pnpm test`: 11 files passed, 2 skipped; 105 tests passed, 14 skipped.
- Worker unit tests: 4 passed for JSON normalization, malformed timestamps, ordering and duration bounds.
- FFmpeg normalized the bundled JFK audio sample to mono 16 kHz WAV; output was 352,078 bytes.
- Real local inference ran with `whisper.cpp/build-ucrt64/bin/whisper-cli.exe` and `ggml-large-v3-turbo.bin` on the bundled 11-second sample. The logs report `using Vulkan0 backend`, AMD Radeon RX 580 2048SP, and `fp16: 0`. It emitted one segment from 0.000s to 10.400s with the JFK speech. The worker parser accepted that actual JSON output. The run took 7.86 seconds; this is one sample measurement, not a general throughput claim.
- The [Vercel Preview for commit `6143639`](https://horizonreboot-ng70ckwhu-irrelevant3.vercel.app) served the Horizon home page with HTTP 200. Using the authenticated Vercel CLI, the deployed worker health route (no learner token) and worker claim route (deliberately invalid worker token) both reached the app and returned JSON `401 unauthorized`, confirming route deployment and auth guards behind deployment protection.
- `git diff --check`: passed.

The existing suite contains tutor/quiz workflow and future-evidence/citation checks, but live AI/database cases are skipped in this environment. The existing answer and quiz routes were left unchanged; live generation was not independently verified here.

## Not verified remotely

- The linked Supabase project currently has no database branches. The migration has **not** been applied; schema, RLS, lease, retry, persistence and account-isolation behavior were not exercised against a database. Production was not changed.
- Vercel has no Preview `SUPABASE_SERVICE_ROLE_KEY` or `WHISPER_WORKER_TOKEN` configured for this integration. Production-only Supabase secrets were not read, copied or used. The public site therefore has not communicated with the local PC worker; no remote video upload, transcription, database persistence or Horizon ingestion was performed.
- A loopback HTTP auth smoke check could not run because this environment blocks local socket access; the deployed preview auth checks above were used instead.
- The live answer/quiz integration suites were skipped, so the report does not claim those APIs are live-verified.

## Review setup needed for remote end-to-end acceptance

Apply `supabase/migrations/20261031235217_whisper_transcription_jobs.sql` to a disposable Supabase review branch, configure `SUPABASE_SERVICE_ROLE_KEY` and a generated `WHISPER_WORKER_TOKEN` on the corresponding Vercel Preview deployment, copy `worker/.env.example` to `worker/.env`, and start `worker/start-worker.ps1` on the Windows PC. Then test with a synthetic account and a video the account is authorized to upload. Do not point this integration at production until the review flow is accepted.
