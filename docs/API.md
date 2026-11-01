# Horizon API and worker communication

This is a source-level route inventory, not a claim that every endpoint has been live-tested. The app uses TanStack Start server routes. Unless stated otherwise, learner endpoints require an authenticated Supabase session; worker endpoints require a worker bearer secret plus job-specific lease authorization.

## Learner-facing endpoints

| Route | Purpose | Auth / data notes |
|---|---|---|
| `POST /api/resources/upload` | Upload learning resource and begin existing ingestion flow | Learner session; storage and records are subject to project policy and RLS. |
| `POST /api/whisper/jobs` | Enqueue transcription for an eligible private video | Learner session; job owner is derived server-side. |
| `GET /api/whisper/jobs` | Read the caller's transcription job state | Learner session; owner-scoped response. |

Request field names and validation should be checked in the route source before creating an external client. The upload flow accepts configured supported media types; URL import does not grant permission to download arbitrary third-party media. Arbitrary server-side URL fetching is prohibited to avoid SSRF/private-network access.

## Worker endpoints

| Route | Purpose |
|---|---|
| `POST /api/whisper/worker/claim` | Atomically claim an available queued job and receive a short-lived signed URL for the authorized private object. |
| `POST /api/whisper/worker/heartbeat` | Report worker health and renew valid job progress/lease state. |
| `POST /api/whisper/worker/jobs/{jobId}` | Submit validated transcript segments or a failure result for the leased job. |

The worker starts outbound HTTPS polling. It must not expose an inbound port. Keep `WHISPER_WORKER_TOKEN` and Supabase service-role credentials out of browser configuration. A job-scoped lease token limits result submission to the claimed work. Signed media URLs are short-lived. Jobs are bounded by lease, retry and concurrency controls in the migration.

## Error handling and limits

Unauthorized requests return `401`. Invalid job state, malformed segment timestamps, expired leases and unsupported upload types are rejected by validation. The worker records failures for retry according to server policy. Exact request schemas, configured file-size caps, retry counts and signed-URL TTL are defined in the route, migration and worker source; they have not been validated against a live deployed database in this local-only pass.

## Operational setup

1. Apply the timestamped migration to an approved non-production database.
2. Configure server-only Supabase service role and a separately generated worker token for that environment.
3. Configure `worker/.env` from `worker/.env.example` with the public app URL, worker token, absolute whisper executable/model paths and FFmpeg path.
4. Run `worker/start-worker.ps1`; confirm backend detection before processing jobs.
5. Upload only content the learner is authorized to process. Verify status, timestamps, indexing, retries and owner isolation.

See [worker operations](WHISPER_WORKER.md) for hardware checks and troubleshooting. Live end-to-end operation has not been demonstrated in this release pass.
