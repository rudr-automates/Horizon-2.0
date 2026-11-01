# Horizon local Whisper worker

Horizon queues private MP4/WebM uploads in Supabase. A Windows worker polls the Horizon server over outbound HTTPS, receives a 10-minute signed URL scoped to one stored object, extracts 16 kHz mono audio with FFmpeg, and runs the existing `whisper.cpp` executable and `ggml-large-v3-turbo.bin`. It posts segment-level timestamps to the server, which validates them and passes a WebVTT representation through Horizon's existing ingestion, chunking, embedding, retrieval, and transcript panel paths. The worker never opens an inbound port and never fetches pasted video links.

## Backend setup

1. Apply `supabase/migrations/20261031235217_whisper_transcription_jobs.sql` to the confirmed Horizon 2.0 Supabase project through the Supabase migration tool. This additive migration adds the owner-readable queue and a `FOR UPDATE SKIP LOCKED` service-role-only atomic claim function. It is not applied yet; the tool's action-time confirmation expired.
2. Configure these **server-only** deployment variables on the Horizon production deployment after the migration is applied:
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role key. Never prefix it with `VITE_`.
   - `WHISPER_WORKER_TOKEN`: random 48-byte-or-longer secret shared only with the worker.
3. Set `HORIZON_API_URL` to the verified production deployment and `HORIZON_SUPABASE_URL` to the Horizon 2.0 Supabase project URL in `worker/.env`.
4. Copy `worker/.env.example` to `worker/.env`; fill the deployment values. `.env` is ignored by Git.

The public Whisper flow is currently unavailable: its production heartbeat endpoint returns 404 because production does not include these local `main` changes. No migration or deployment has been completed in this finalization pass. Do not start the worker until the migration and server-only credentials are configured and verified.

## Windows setup and launch

Use Python 3.11+ and the already installed local assets. Configure `WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`, `FFMPEG_PATH`, and `WHISPER_RUNTIME_PATH` with absolute paths; defaults match the local Horizon checkout and MSYS2 UCRT64 setup. The worker checks all paths, the model's SHA-1, and that the executable initializes with the configured runtime. Its `PATH` includes the CLI directory and `C:\msys64\ucrt64\bin` so the required MSYS2 DLLs can load.

Run from PowerShell:

```powershell
Copy-Item worker/.env.example worker/.env
# Edit worker/.env; use a generated secret, never the placeholder.
powershell -ExecutionPolicy Bypass -File worker/start-worker.ps1
```

The worker handles one job at a time. To start at sign-in, create a Windows Task Scheduler task with trigger **At log on**, program `powershell.exe`, arguments `-NoProfile -ExecutionPolicy Bypass -File "<checkout>\worker\start-worker.ps1"`, and the checkout as the working directory. Stop with Ctrl+C or stop the task. The worker polls again after a network outage; claimed work whose heartbeat lease expires is retried with bounded backoff.

## Model and GPU policy

The expected local model checksum is `4AF2B29D7EC73D781377BFD1758CA957A807E941`. Startup verifies it. The worker requires Vulkan evidence in Whisper's logs by default; it never silently accepts CPU inference. Set `WHISPER_ALLOW_CPU_FALLBACK=true` only for an explicitly approved recovery run; the selected backend is recorded with the transcript. Vulkan being enabled at build time does not itself prove every runtime selected the GPU. No FP16 performance claim is made.

## Job lifecycle and security

`queued → claimed → downloading → extracting_audio → transcribing → normalizing → indexing → ready`; errors enter `retry_wait` with a bounded attempt count or `failed`. The service records idle and active worker heartbeats; the learner's transcript panel shows whether the PC worker checked in during the last 90 seconds. Learners can only read their own jobs under RLS. The service role is only used by server routes, while the worker receives a random lease token per claim and must present it with the shared worker token for heartbeats and results. Leases rotate after reclaim, which rejects stale result submissions. Signed media URLs expire after 10 minutes; the worker accepts HTTPS from only the configured Supabase host, rejects redirects elsewhere, caps media at 200 MB, and deletes its temporary source and WAV when a job ends. Raw Whisper JSON is kept under the configured local output directory for diagnostics.

The application accepts MP4/WebM private uploads only. YouTube, Vimeo, and direct links remain on the existing playback/manual-caption path. There is no arbitrary URL downloader, DRM circumvention, or login/access-control bypass. The transcript has Whisper segment timestamps; word-level alignment is not claimed. Existing tutor and quiz APIs and temporal evidence eligibility remain the consumers of indexed transcript chunks.

## Troubleshooting

- **Worker says queue unconfigured**: apply the migration to the confirmed Horizon 2.0 project and set the server-only `SUPABASE_SERVICE_ROLE_KEY` and `WHISPER_WORKER_TOKEN`.
- **Executable fails to initialize**: verify the absolute CLI path and set `WHISPER_RUNTIME_PATH` to the MSYS2 UCRT64 `bin` directory. The worker performs a `--help` startup check.
- **Model checksum mismatch**: verify the local large-v3-turbo model; if it is an intentionally different verified copy, set its expected SHA-1 in `WHISPER_MODEL_SHA1`.
- **GPU not confirmed**: inspect the per-job whisper.cpp logs and Vulkan driver/device availability. CPU fallback is disabled by default.
- **No jobs while PC is off**: jobs stay queued in Supabase; restart the worker when the PC is available.
- **Transcript rejected**: ensure the job's stored upload is valid and review the bounded job error in the lesson Transcript tab.

## Verification boundaries

Local parser/worker tests can run without network access. A successful public remote job requires the production migration, server-only service role key and worker token, a running Windows worker, and a test account/upload. The migration confirmation expired before application; the worker token is not configured. No remote job has been claimed or processed.
