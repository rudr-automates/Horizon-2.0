# Local setup and environment

## Prerequisites

- Node.js 20.19 or newer (verified with Node 24.19.0).
- npm with the checked-in `package-lock.json`. `bun.lock` also exists, but Bun was
  not installed in the verification environment. Use one package manager.

```sh
npm ci
```

## Environment

`.gitignore` ignores `.env`, `.env.*`, `.dev.vars` and `.dev.vars.*`.
`.env.example` is the tracked template with names only.

```sh
cp .env.example .env
```

| Variable                                              | Scope            | Purpose                                                        |
| ----------------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `SUPABASE_URL`                                        | Browser + server | Project URL.                                                   |
| `SUPABASE_PUBLISHABLE_KEY`                            | Browser + server | Publishable key; RLS is the boundary.                          |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser          | Build-time copies for the client.                              |
| `SUPABASE_PROJECT_ID` / `VITE_SUPABASE_PROJECT_ID`    | Browser + server | Optional tooling identifier.                                   |
| `GEMINI_API_KEY`                                      | Server only      | Primary free-tier language model.                              |
| `GROQ_API_KEY`                                        | Server only      | Free-tier fallback language model.                             |
| `JINA_API_KEY`                                        | Server only      | Embeddings and reranking.                                      |
| `AI_MODEL_PREFERENCES`                                | Server only      | Optional JSON override of the free model allowlist.            |
| `VIDEO_TRANSCRIPTION_MODEL`                           | Server only      | Optional timestamped-transcription model override.             |
| `SUPABASE_SERVICE_ROLE_KEY` / `WHISPER_WORKER_TOKEN`  | Server only      | Optional local Whisper queue; not used by automatic ingestion. |

Never give a server key a `VITE_` prefix. The development server was verified to
load the root `.env`: `GET /api/ai/health` reports provider names and
configured/unconfigured booleans, never values. The same probe is safe on a
deployment.

`SUPABASE_ACCESS_TOKEN` is only needed for local migrations or type generation.
It is not read by the application at runtime.

## Supabase

All migrations in `supabase/migrations` are applied to the connected project,
including:

- `20261025170500_focus_task_ownership_guard.sql`
- `20261025171000_ai_retrieval_foundation.sql` — pgvector, resources, chunks,
  tutor history and quiz attempts.
- `20261026130000_resource_file_storage.sql` — private `learning-resources`
  bucket and owner-folder policies.
- `20261031235217_whisper_transcription_jobs.sql` — optional desktop Whisper
  queue.
- `20261101120000_video_ingestion_jobs.sql` — durable automatic video ingestion
  jobs with owner-only RLS. See
  [universal video ingestion](VIDEO_INGESTION_PIPELINE.md).

The MIT 15.773 course is seeded with 11 lecture transcripts, 14 note PDFs and a
syllabus. To rebuild it after changing the embedder or source files:

```sh
node --env-file=.env scripts/ingest-mit-course.mjs
```

The script reads the service key through the Supabase Management API in memory,
never prints it, and replaces only the `mit-15-773` demo resources. `--dry-run`
parses and chunks the local files without calling Jina or writing to Supabase.

Its inputs are deliberately untracked: `static_resources/`, `resources/`,
`lists/`, `pages/`, `video_galleries/`, `download/` and `external-resources/`,
plus `content_map.json` and `data.json`, hold the downloaded OpenCourseWare
mirror and the exported Lovable asset tree (~85 MB), and `.gitignore` excludes
them at the repository root. A fresh clone runs without them — the course is
already seeded in Supabase and the PDFs learners open are committed under
`public/course/mit-15-773/`. To re-run the script, restore those directories from
your original download; `--dry-run` names any missing file.

Regenerate types after a schema change:

```sh
npx supabase gen types typescript --project-id <project-ref> --schema public \
  > src/integrations/supabase/types.ts
```

## Commands

```sh
npm run dev        # Vite development server
npm test           # deterministic tests; no network or API keys
npx tsc --noEmit   # type check
npm run build      # production build (Cloudflare/Nitro default)
npm run lint       # ESLint
```

Real-provider checks are opt-in:

```sh
RUN_REAL_AI_SMOKE=1 node --env-file=.env \
  node_modules/vitest/vitest.mjs run src/test/real-ai.smoke.test.ts

RUN_LIVE_WORKFLOW=1 node --env-file=.env --env-file=.env.e2e \
  node_modules/vitest/vitest.mjs run src/test/live-workflow.test.ts
```

`.env.e2e` needs `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` for an existing
confirmed learner. The live workflow answers a question against the seeded MIT
lecture, generates and grades a quiz, uploads a private note, verifies its
signed citation, and deletes the temporary resource.

## Video uploads

Uploading an MP4/WebM (or importing a direct MP4/WebM link) starts automatic
processing as soon as the lesson opens: the media is uploaded to the Gemini
Files API, transcribed into timestamped passages, chunked and embedded. The
Transcript tab shows the current stage and any error, and the tutor, Explain
simply, Summarize so far and quizzes use the indexed evidence. No extra setup is
needed beyond `GEMINI_API_KEY`; see
[universal video ingestion](VIDEO_INGESTION_PIPELINE.md).

## Resource uploads

Signed-in learners can upload PDF, PPTX, Markdown, text, code and SRT/WebVTT
files from a lesson's **Study materials** tab. Limits are 10 MB and 220 passages.
PDF and PPTX text is extracted on the server. Legacy `.ppt` and image-only scans
are rejected with an explicit message rather than indexed as empty content.

## Vercel

The app builds with Nitro's Vercel preset:

```sh
NITRO_PRESET=vercel npm run build
```

This produces `.vercel/output` — the Vercel Build Output API tree with
`functions/__server.func`, `static/` and a `config.json` whose last rule sends
every unmatched request to `/__server`. `vercel.json` pins both the build command
and `"framework": "tanstack-start"`, and deliberately leaves the output
directory unset because the TanStack Start/Nitro preset already consumes
`.vercel/output`.

If the deployment instead serves plain HTML for `/`, `/sign-in` and
`/api/ai/health`, Vercel is running the project as a static site (framework
"Other"). That happens when the project has no recognised framework preset: the
output directory falls back to `public/` or the repository root, and a stray
root `index.html` becomes every route. `vercel.json` now sets the preset, and the
root-level documents of the downloaded course mirror (`index.html`, `sitemap.xml`,
`robots.txt`, `favicon.ico`) are deleted and gitignored so they cannot hijack `/`.
The dashboard project must still match:

| Setting          | Required value                                              |
| ---------------- | ----------------------------------------------------------- |
| Root Directory   | repository root (empty)                                     |
| Framework Preset | TanStack Start                                              |
| Build Command    | `NITRO_PRESET=vercel npm run build`                         |
| Install Command  | `npm ci`                                                    |
| Output Directory | **empty** — never `dist`, `public`, `.` or `.vercel/output` |

Set the environment variables above in the Vercel project; `VITE_*` values are
required at build time, while AI and Supabase server values are required at
runtime. `pdfjs-dist` is bundled into the server function. No deployment is
performed by this repository.

## Manual checks still required

- Sign in as two learners and confirm notes, bookmarks, progress, tasks, events,
  focus sessions, uploaded resources, tutor history and quiz attempts do not
  cross accounts.
- Play each imported/YouTube lesson in a browser and confirm the player API and
  timestamp capture work on the target network.
- Confirm the provider free-tier terms still match the configured models before
  a public launch.
