# Localhost acceptance and sign-off report — Horizon 2.0

Report updated 30 October 2026. The detailed full acceptance run was executed
26 October against `npm run dev` at `http://localhost:8080`, the connected
Supabase project, and the three configured AI providers. A follow-up local UI,
resource-inventory and full-check recheck was then run on 30 October. The tables
distinguish that recheck from the original provider/upload evidence. A final
repository-readiness pass followed, covering migration recovery, ignore rules,
secret scoping and the full check suite again (section 7). No Git, GitHub,
hosting or deployment operation was performed at any point.

## 1. Feature matrix

**Live recheck (30 Oct):** The local app served `/`, `/sign-in`, `/library`,
`/courses` and `/api/ai/health` with 200; an unknown API route returned 404; a
served MIT lecture PDF returned 200 `application/pdf` and a local WebVTT track
returned 200 `text/vtt`. A course MP4 path from the downloaded course metadata
returned 404 because that file is not in the workspace. Health reports Gemini
(`gemini-3.5-flash-lite`), Groq (`openai/gpt-oss-20b`) and Jina
(`jina-embeddings-v3`, 1,024 dimensions) configured with `paidFallback: false`.

A complete local-video slice was then exercised in the signed-in browser:
`POST /api/videos/upload` returned **201** and created a private lesson; the clip
played from a short-lived signed URL, reported its real 60-second duration, and
the duration persisted to the lesson row. Uploading the matching WebVTT through
`POST /api/resources/upload` returned **201** with 4 embedded passages, and the
Transcript tab showed all 10 timestamped cues as `available`. At 0:31 the tutor
correctly refused the question "What happens to a review card when I answer the
question wrong?" because the answering cue (0:30–0:36) had not finished playing.
After advancing to 0:41 the same question returned a grounded answer,
"A question you get wrong returns to the beginning of the schedule.", with a
verbatim citation to 0:18–0:36 from `gemini-3.5-flash-lite` (hybrid retrieval,
25.5 s), and clicking the citation seeked the player to 0:18. Sign-out,
second-account isolation and the quiz/practice drills were not repeated today.

| Feature                                              | Result                                  | When / how                                                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in and session persistence across reload        | Pass (26 Oct)                           | Full acceptance run: signed-in session survived reloads; a private/incognito window with no session was redirected to `/sign-in?redirect=…`. Not repeated 30 Oct.                                   |
| Sign-out                                             | Not re-tested this pass                 | Tested in the first acceptance run; no sign-out code changed.                                                                                                                                       |
| Course catalogue and lesson open                     | Pass (30 Oct)                           | Signed-in MIT lesson rendered with 252 timestamped transcript passages and the tutor card. The video embed element was present, but playback progression was not verified in this recheck.          |
| **Local video upload (MP4/WebM) to private storage** | Pass (30 Oct)                           | Live: uploaded the 3.4 MB synthetic MP4 from the signed-in page -> 201, private `lesson-videos` object under the owner's folder, lesson created with a `storage://` reference.                      |
| Local video playback from a signed URL               | Pass (30 Oct)                           | Live: signed Supabase URL streamed the clip, `readyState 4`, 60 s duration; playback advanced to 0:02 and seeked to 0:31; duration persisted (`duration_seconds = 60`).                             |
| Uploaded video without a transcript is not "ready"   | Pass (26 Oct)                           | Full acceptance run confirmed `transcript_status = unavailable` and the panel says playback does not automatically create a transcript. Not repeated 30 Oct.                                        |
| Caption (VTT/SRT) association with the lesson        | Pass (30 Oct)                           | Live: WebVTT upload -> 201, 4 embedded citable passages, and the Transcript tab then showed all 10 cues with `available` and clickable seeking.                                                     |
| Recorded duration enables position-aware tutoring    | Pass (26 Oct)                           | Full acceptance run verified persisted player duration and accepted a timestamp-aware tutor request at 0:33.                                                                                        |
| Timestamp-aware question with real provider          | Pass (30 Oct)                           | Live on the uploaded lesson at 0:41: `gemini-3.5-flash-lite` answered from the indexed cues with a verbatim quote (25.5 s, hybrid retrieval). The 26 Oct run also covered PDF/slide citations.      |
| Citation opens its source                            | Pass (30 Oct)                           | Live: clicking the 0:18-0:36 transcript citation seeked the player to 0:18. The 26 Oct run also opened a cited PPTX slide through its signed URL.                                                   |
| Future video content excluded                        | Pass (30 Oct)                           | Live: at 0:31 the question whose answer sits in cue 0:30-0:36 was refused; the same question at 0:41 was answered from that cue. The 26 Oct run also showed slide-only evidence at 0:05.            |
| Insufficient-evidence refusal                        | Pass (30 Oct)                           | Live: the 0:31 question returned "The lesson evidence does not support an answer to that question yet." instead of an invented answer. The 26 Oct run also refused an unrelated recipe question.    |
| Explain simply                                       | Pass (26 Oct)                           | Earlier full browser run returned grounded transcript/page citations. Not invoked in the 30 Oct recheck.                                                                                            |
| Summarize so far                                     | Pass (26 Oct)                           | Full acceptance run returned five bullets with citations at or before the playhead.                                                                                                                 |
| Follow-up question with history                      | Pass                                    | **Earlier**.                                                                                                                                                                                        |
| Quick quiz generation, grading, saved result         | Pass (26 Oct)                           | Full acceptance run generated four questions, graded 100%, showed evidence citations and a saved result; server re-read the persisted attempt.                                                      |
| Exam drill generation                                | Pass (26 Oct)                           | Full acceptance run rendered six questions; that attempt was left ungraded after generation.                                                                                                        |
| Exam / interview drill grading and persistence       | Pass                                    | **Earlier** (exam 6/6, interview 4/4, both saved). Not re-run this pass: identical grading path to the quiz verified above.                                                                         |
| Tutor feedback ("Helpful?")                          | Pass                                    | **Earlier**.                                                                                                                                                                                        |
| Notes persist across reload                          | Pass (26 Oct); not confirmed in recheck | Earlier acceptance recorded note persistence. The currently opened lesson's Notes tab was empty; no note was written or reloaded in this recheck.                                                   |
| Bookmarks and progress persist                       | Pass (26 Oct); not confirmed in recheck | Earlier acceptance reported persistence; this recheck did not re-verify a saved bookmark or progress record.                                                                                        |
| Tasks, calendar, focus timer                         | Not re-tested this pass                 | Dashboard code unchanged since the earlier runs.                                                                                                                                                    |
| Resource upload — Markdown, text, code               | Pass (26 Oct)                           | Full acceptance run uploaded each type (HTTP 201, one chunk each, Jina embeddings complete, private). Not repeated 30 Oct.                                                                          |
| Resource upload — PDF (page provenance)              | Pass (earlier)                          | MIT lecture PDFs indexed with page locators and cited at page 26 in the earlier workflow.                                                                                                           |
| Resource upload — PPTX (slide provenance)            | Pass (26 Oct)                           | Full acceptance run uploaded a three-slide synthetic educational deck, extracted three slide-located chunks with embeddings, and cited Slide 2. Not repeated 30 Oct.                                |
| Legacy `.ppt` rejection                              | Pass (26 Oct)                           | Full acceptance run returned HTTP 400 with an instruction to save as `.pptx`.                                                                                                                       |
| Unsupported / corrupt files rejected                 | Pass (26 Oct)                           | Full acceptance run rejected `.exe` (415), text disguised as PDF, truncated PDF and empty file.                                                                                                     |
| File-size limits                                     | Pass (30 Oct)                           | Re-verified: an 11 MB resource returned 413 `invalid_file`; an oversized video returned 413 `file_too_large`. The 26 Oct run also covered the 250 MB video case.                                    |
| Same-origin / auth on write endpoints                | Pass (30 Oct)                           | Re-verified: no token → 401 on both upload routes; foreign `Origin` → 403. Each returned a JSON error body, and no row or object was created.                                                       |
| Video ownership checks                               | Pass (26 Oct)                           | Full acceptance run verified demo-lesson upload → 403 and unknown lesson → 404.                                                                                                                     |
| Bucket privacy (new `lesson-videos`)                 | Pass (26 Oct)                           | Full acceptance run verified anonymous read/sign denied and owner signing allowed; policies are scoped by `storage.foldername(name)[1] = auth.uid()`.                                               |
| Cross-account table isolation                        | Pass                                    | **Earlier**: second learner saw 0 notes/bookmarks/attempts, foreign read/update returned 0 rows, forged `user_id` insert rejected by RLS. Not re-run this pass (no table code changed).             |
| Hybrid retrieval and embedding-space compatibility   | Pass                                    | **Earlier** (deterministic tests) and through live answers labelled `hybrid` in the 26 Oct run.                                                                                                     |
| Knowledge-graph-assisted retrieval                   | Pass (scoped; deterministic)            | Earlier pass: sequence expansion plus cross-resource concept links; six deterministic tests ensure ineligible scope/time evidence is never introduced.                                              |
| Provider failure / quota-exhaustion behaviour        | Pass (deterministic)                    | Covered by `ai-gateway` and `ai-quota` suites: safe `rate_limited`/`quota_exhausted` errors, bounded retries, no paid fallback. No live quota condition was probed.                                 |
| Lint (`eslint .`)                                    | Pass (30 Oct)                           | Re-run, exit 0: **0 errors, 8 warnings** (`react-refresh/only-export-components`, pre-existing UI files).                                                                                           |
| Formatting (`prettier --check .`)                    | Pass (30 Oct)                           | Re-run, exit 0, all files clean.                                                                                                                                                                    |
| Type check (`npx tsc --noEmit`)                      | Pass (30 Oct)                           | Re-run, exit 0.                                                                                                                                                                                     |
| Automated tests (`npm test`)                         | Pass (30 Oct)                           | Re-run: **96 passed** (2 new caption-parser tests), 14 opt-in live-provider tests skipped, exit 0.                                                                                                  |
| Production build (`npm run build`)                   | Pass (30 Oct)                           | Re-run, exit 0 (Nitro/Cloudflare output generated).                                                                                                                                                 |
| Vercel build (`NITRO_PRESET=vercel npm run build`)   | Pass (30 Oct)                           | Re-run, exit 0; `.vercel/output` regenerated.                                                                                                                                                       |
| Local HTTP smoke                                     | Pass (30 Oct)                           | `/`, `/sign-in`, `/library`, `/courses`, `/api/ai/health` → 200; served MIT PDF → 200 `application/pdf`; local VTT → 200 `text/vtt`; unknown API → 404; referenced course MP4 → 404 (absent asset). |
| Bundle secret scan                                   | Pass (30 Oct)                           | Re-scanned `.output/public` and `.vercel/output/static` after today's builds for provider key names and key-shaped strings: 0 matches. No provider credential is reachable from browser code.       |

The resource inventory confirms 14 MIT lecture-note PDFs under
`static_resources/` and 11 timestamped MIT VTT caption files there.
`scripts/fixtures/spaced-repetition-demo.mp4` is the only local MP4/WebM found
(valid 60-second MP4, 3,423,170 bytes); the course's referenced MP4 files are
absent locally. The root PPTX and `scripts/fixtures/spaced-repetition-practice.pptx`
have identical SHA-256 hashes, confirming the root deck is a copy of the
synthetic fixture rather than a separate downloaded course deck. No file was
submitted through the upload dialog during this recheck. No new provider request,
account creation or learner-data write was made.

## 2. Bugs fixed in this pass

1. **A repeated citation withheld a correct answer.** The model cited the same
   passage twice; validation rejected the whole answer for `duplicate_citation`
   even though both quotes were verbatim. Citations are now de-duplicated
   before validation (`dedupeCitations`), while the validator itself stays
   strict — a duplicate of an ineligible source is still ineligible. Regression
   test added in `src/test/evidence.test.ts`.
2. **Imported and uploaded videos could never use the tutor.** Lessons start
   with `duration_seconds = 0` and the tutor refuses position checks without a
   duration. The player now records the real duration once, and the lesson row
   is updated (RLS keeps this to the owner).
3. **Stored videos had no playback path.** Added `storage://` resolution to a
   short-lived signed URL in `lesson-player.tsx`, with explicit loading and
   failure states.
4. **Valid WebVTT with a NOTE block was rejected.** `parseCaptions` stripped the
   `WEBVTT` header and then treated any remaining block without a `-->` as a
   malformed cue, so a standards-compliant file containing a NOTE (or STYLE /
   REGION) comment failed with "The captions are not valid, ordered SRT or
   WebVTT cues." Those blocks are now skipped, while a block of undated text is
   still rejected. Two regression tests added in `src/test/learning.test.ts`.
5. **Uploaded captions never reached the transcript panel.** A VTT/SRT uploaded
   through Study materials became retrievable evidence, but the lesson row kept
   `transcript_status = unavailable`, so the Transcript tab still claimed no
   captions existed and none of the cues were seekable. Ingestion now writes the
   parsed segments to the lesson after the resource is indexed
   (`src/server/ingestion/service.server.ts`), and a failure there is logged
   instead of silently discarding an already-indexed source.

## 3. Database changes

Applied with `npx supabase db push` to the connected project; **no rows were
updated or deleted**.

| Migration                             | Change                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20261026180000_lesson_video_storage` | New private bucket `lesson-videos` (250 MB limit, `video/mp4` + `video/webm`) and four owner-folder RLS policies (select/insert/update/delete).                                                                                                                                                                                                                                                             |
| `20261025194146_67a51cb0…`            | **Recovered, not reconstructed.** The original four statements (owner-folder RLS policies on the private `learning-resources` bucket) were read back verbatim from `supabase_migrations.schema_migrations.statements` in the connected project and restored with a provenance header. The version was already applied, so `db push` does not re-run it — a dry run reports "Remote database is up to date". |

Local and remote migration sets now match (verified with `supabase migrations
list --linked`). Existing learner data, demo lessons and indexed resources were
untouched.

## 4. Video and PowerPoint results in detail

**Local video** — `scripts/fixtures/spaced-repetition-demo.mp4` is a generated,
labelled synthetic fixture (60 seconds, 3,423,170 bytes, valid MP4) and the only
local video file in the workspace. It was uploaded through the real
`POST /api/videos/upload` route from the signed-in page: **201**, one private
object under `lesson-videos/<user>/<lesson>-<rand>.mp4`, and a lesson created
with a `storage://` reference. The learner page then played it from a signed URL
(`readyState 4`, duration 60 s, progress to 0:02 and a seek to 0:31), and the
recorded duration persisted. The matching WebVTT uploaded through
`POST /api/resources/upload` returned **201** with 4 embedded passages; the
Transcript tab showed 10 cues, `available`. Invalid-upload rejections were
re-verified over HTTP: no token -> 401, foreign `Origin` -> 403, oversized video
-> 413.

The downloaded MIT course includes 11 video entries and 11 local timestamped VTT
tracks, but its course MP4 references are not local; a representative local URL
returns 404. Those original lecture videos still need to be downloaded for local
playback.

**PowerPoint** — `scripts/fixtures/spaced-repetition-practice.pptx` is the
3-slide synthetic educational fixture with speaker notes. The root-level PPTX
has the same SHA-256, so it is not an independent course deck. The 26 Oct
acceptance record reports successful upload, slide-provenance extraction,
embeddings, citation and source opening; it was not re-uploaded in this pass.

## 5. Known limitations

**Local course video gap:** the downloaded MIT course metadata references MP4s
that are not present locally. The synthetic test video is present, and the prior
acceptance record reports its upload/playback flow passing. Playing the original
MIT lectures locally requires downloading those MP4 files; this does not block
reviewing the upload workflow with the synthetic fixture.

Deferred enhancements (explicitly not built, documented in code and docs):

| Item                                                | State                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCR for scanned PDFs and image-only slides          | Not implemented. Uploads say "scans need OCR first"; unreadable PDFs are refused with a clear message rather than indexed as empty.                                                                                                                                                                                                          |
| Legacy `.ppt` conversion                            | Rejected with "save as .pptx" (verified). Requires LibreOffice/PowerPoint on the host to convert.                                                                                                                                                                                                                                            |
| Token streaming                                     | Answers arrive as one response after verification.                                                                                                                                                                                                                                                                                           |
| Distributed / persistent quota ledger               | The application ledger is in-memory and resets with the dev server; each provider's free tier is the real ceiling. Before more than one instance: move reservations into Postgres or Redis with atomic counters and TTLs equal to the provider windows.                                                                                      |
| Entity-level knowledge graph                        | The graph is playback-sequence links plus shared-concept links across eligible resources. No entity extraction, no ontology, no Graph RAG claim.                                                                                                                                                                                             |
| Automatic transcription                             | Uploaded videos need captions supplied by the learner; nothing pretends a transcript exists.                                                                                                                                                                                                                                                 |
| Automated browser suite                             | This acceptance used a live browser session; no committed E2E runner.                                                                                                                                                                                                                                                                        |
| Second-account re-verification of the new bucket    | Not run: no second credentials were available. Verified instead by anonymous denial, owner allow, and the folder-scoped policy definition.                                                                                                                                                                                                   |
| Leaked-password protection                          | Supabase advisor WARN — a dashboard setting, not code.                                                                                                                                                                                                                                                                                       |
| Unused `src/integrations/supabase/client.server.ts` | Service-role helper, imported nowhere and its env var is unset.                                                                                                                                                                                                                                                                              |
| Test residue                                        | Two synthetic lessons (`Spaced Repetition (synthetic demo)` and `Acceptance check — synthetic spaced-repetition clip`), 5 indexed resources, 2 private videos and 1 unanswered exam attempt. Every one of the 7 stored objects resolves to those lessons; there are no orphaned objects. Safe to remove — section 7 lists the exact records. |
| Fresh-database provisioning test                    | Not executed: `supabase db reset`/`db dump` need a running Docker daemon, which this machine does not have. Covered instead by object-level coverage (221/221 live objects traced to a repository migration) and a reconciled migration history. See section 7.                                                                              |

## 6. Manual actions for you

The local upload, caption, playback, tutor, citation and future-content paths
were exercised end to end on 30 Oct, so no repeat is required to review them.
The lesson named "Acceptance check — synthetic spaced-repetition clip" in
**Your library** is the artifact of that run; delete it if you do not want it.
Still worth checking by hand: sign-out, a second account's isolation, and the
quiz/exam/interview drill flows.

Optional:

1. In the Supabase dashboard, enable leaked-password protection (advisor warn).
2. `horizon.acc.b.2026@example.com` does not exist and never did. The second
   account used for the isolation test is the confirmed test user
   `horizon-e2e-1792954009355@example.com` (profile "Horizon verification
   learner"); it owns no lessons or resources. Remove it from
   **Authentication → Users** if you do not want it carried into the new project.
3. Nothing is pending for migration history: the last untracked version is now
   recovered in the repository and the local/remote sets reconcile (section 7).
4. To download the original MIT lecture videos locally, place the course MP4s
   where the lesson's `video_url` points, or import them through **Import video →
   Upload a file** so they are stored privately instead.

## 7. Final GitHub-readiness pass

This pass prepared a manual push to a new repository. No repository was
initialised, no remote was contacted and nothing was deployed.

### 7.1 The untracked migration is recovered

Version `20261025194146` was applied to the connected project by the hosting
platform on 25 Oct 19:41:46 and never landed in the repository, so the file here
was an empty `select 1;` placeholder. The original statements still existed in
the project's own history table.

| Step                              | Result                                                                                                                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read the version from the project | `supabase_migrations.schema_migrations.statements` holds 1 statement of 805 bytes for this version                                                                                                                                                        |
| Content                           | `create policy` for `own folder read`, `own folder upload`, `own folder update` and `own folder delete` on `storage.objects`, scoped to `bucket_id = 'learning-resources'` and the caller's `auth.uid()` folder                                           |
| Action                            | Restored verbatim with a provenance header naming the source and stating they were recovered rather than rewritten                                                                                                                                        |
| The "duplicate" policies          | `20261026130000_resource_file_storage.sql` later adds the same four rules under different names. Both sets are live and equally owner-scoped, so applying the files in order on a fresh database reproduces the exact current state — nothing was dropped |

Verification, both exit 0:

- `npx supabase migration list --linked` — all 10 versions present locally and
  remotely, with matching names and timestamps.
- `npx supabase db push --linked --dry-run` — `Remote database is up to date.`

Fresh-database coverage was established by catalog comparison: all **221 live
objects** (13 tables, 149 columns, 18 policies, 27 indexes, 11 triggers, 3
functions) trace to a statement in `supabase/migrations`. The only unmatched
names were 15 auto-generated primary-key/unique index names, and each of those is
an inline `PRIMARY KEY`/`UNIQUE` clause in the table DDL.

**Not verified — literal fresh apply.** `supabase db reset` and `supabase db dump`
both require a running Docker daemon, which this machine does not have (`failed to
connect to the docker API … dockerDesktopLinuxEngine`). With Docker available,
`npx supabase start && npx supabase db reset` applies every migration to a clean
local stack. Until that runs, the schema is complete-by-inspection, not
proven-by-rebuild.

### 7.2 Ignore rules and environment safety

`.env` and `.env.*` are ignored, with `!.env.example` re-included; the example
file holds empty values and commented-out names only, so it contains no
credential. `.vercel/` was already ignored. Added in this pass:

| Added                                                                                                                                 | Why                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/.temp/`                                                                                                                     | CLI link state (project ref); regenerated by `supabase link`                                                                                                                                                                         |
| `.local-run/`                                                                                                                         | Dev-server logs, pids and scratch files written by local tooling                                                                                                                                                                     |
| `.freebuff/`                                                                                                                          | Per-machine agent marker that its own `.gitignore` also excludes                                                                                                                                                                     |
| `download/ external-resources/ lists/ pages/ resources/ static_resources/ static_shared/ video_galleries/ content_map.json data.json` | The downloaded OpenCourseWare mirror and the exported Lovable asset tree (~85 MB), root-anchored so `src/routes/api/resources/` and `public/course/` stay tracked. Inputs to `scripts/ingest-mit-course.mjs`, not application source |
| `*.tsbuildinfo`                                                                                                                       | Local incremental build metadata                                                                                                                                                                                                     |

What stays tracked on purpose: `src/`, `supabase/migrations/`, the tests, the
configs, the docs, and `public/` — including `public/course/mit-15-773/` (14 note
PDFs plus the syllabus, 32 MB), because PDF citations open those exact paths.

Two other hygiene items: the stray root file
`1c8dba9a-aac7-4a6c-99f9-27a955d0c072.pptx` was deleted after confirming its
SHA-256 is identical to `scripts/fixtures/spaced-repetition-practice.pptx`; and
`.env` was left byte-for-byte untouched (its mtime is still 25 Oct 23:47).
`vercel.json` pins `installCommand: npm ci`, so the extra `bun.lock`/`bunfig.toml`
cannot make the host pick a different package manager than the one every check
was run with.

### 7.3 Credentials stay server-side

The actual values in `.env` were searched for across 564 files — both build
outputs, `src/`, `scripts/`, `docs/`, `public/` and the migrations:

- **0** secret values found. `GEMINI_API_KEY`, `GROQ_API_KEY`, `JINA_API_KEY` and
  `SUPABASE_ACCESS_TOKEN` appear in no bundle, source file, test or document.
- Only the browser-safe Supabase URL, publishable key and project id appear in the
  client bundle, which is their purpose (`sb_publishable_…`, still enforced by RLS).
- **0** credential-shaped literals (`gsk_…`, `AIza…`, `sb_secret_…`, HS256 JWTs).

Code-level findings, left as they are rather than "cleaned up":

- `src/integrations/supabase/client.server.ts` reads `SUPABASE_SERVICE_ROLE_KEY`,
  is imported nowhere, and that variable is not set in `.env`. It cannot reach a
  bundle; it is unused privileged code, documented here instead of deleted.
- `/api/ai/health` is deliberately unauthenticated: it returns configured
  booleans, model ids and `paidFallback: false`, never a value, and makes no
  provider call.
- Every AI entry point (`src/lib/ai-tutor.functions.ts`) uses
  `requireSupabaseAuth`, a zod schema, and a server-derived `context.userId`;
  no endpoint accepts a client-supplied user id.

### 7.4 Checks re-run after these changes

| Check                                 | Result                                                     |
| ------------------------------------- | ---------------------------------------------------------- |
| `npx eslint .`                        | exit 0 — 0 errors, 8 pre-existing `react-refresh` warnings |
| `npx prettier --check .`              | exit 0 — all files clean                                   |
| `npx tsc --noEmit`                    | exit 0                                                     |
| `npm test`                            | exit 0 — 96 passed, 14 opt-in live-provider tests skipped  |
| `npm run build`                       | exit 0 — Nitro/Cloudflare output regenerated               |
| `NITRO_PRESET=vercel npm run build`   | exit 0 — `.vercel/output` regenerated                      |
| `supabase migration list --linked`    | exit 0 — 10/10 versions reconcile                          |
| `supabase db push --linked --dry-run` | exit 0 — "Remote database is up to date"                   |

No live provider call was made in this pass; the provider evidence in section 1
stands from the earlier runs and no code that touches it changed.

### 7.5 What is left for you

| Item                       | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic test records     | Two lessons, both yours and both synthetic: `Spaced Repetition (synthetic demo)` (`121424c9…`, 4 resources, 3 tutor exchanges, 2 quiz attempts, 1 note) and `Acceptance check — synthetic spaced-repetition clip` (`ba1fc15c…`, 1 transcript resource, 1 tutor exchange). Deleting the lessons cascades to all of it; their 7 storage objects (2 videos, 5 documents) then need removing from the `lesson-videos` and `learning-resources` buckets in **Storage** |
| Test account               | `horizon-e2e-1792954009355@example.com` — confirmed, no lessons or resources of its own. Delete from **Authentication → Users** if unwanted                                                                                                                                                                                                                                                                                                                       |
| Demo media on Vercel       | 5 of the 16 lessons (`provider = 'direct'`) still point at `/__l5e/assets-v1/…`, i.e. Lovable-hosted media. The 11 MIT lectures use YouTube and are portable. Those 5 need re-uploading through **Import video → Upload a file** (verified working) or re-pointing at a new URL before the demo looks right off-Lovable                                                                                                                                           |
| Fresh-DB proof             | Run `npx supabase start && npx supabase db reset` on a machine with Docker to convert the schema check from inspection to rebuild                                                                                                                                                                                                                                                                                                                                 |
| Leaked-password protection | Still a Supabase advisor warning; a dashboard setting, not code                                                                                                                                                                                                                                                                                                                                                                                                   |
| Two lockfiles              | `bun.lock` + `bunfig.toml` alongside `package-lock.json`. Harmless because `vercel.json` forces `npm ci`; drop the bun files if you want a single canonical manager                                                                                                                                                                                                                                                                                               |

## 8. Readiness decision

**READY FOR MANUAL GITHUB PUSH.**

The prototype sign-off is unchanged: it remains ready for final user review, with
the local-course-media caveat recorded in section 5. The repository side is now
clean too — the last untracked migration is recovered verbatim and both histories
reconcile, every live schema object traces to a migration file, `.env` is excluded
while `.env.example` carries placeholders only, no AI key or service-role
credential appears in any of the 564 scanned files, the stray duplicate deck is
gone, and lint, formatting, typecheck, the 96-test suite, both builds and the
migration dry run all exited 0.

The one readiness item I could not prove is a clean rebuild of the database from
the repository, because that needs Docker. And two housekeeping items are yours to
decide: the synthetic lessons plus the `horizon-e2e-…` test user, and the five
Lovable-hosted demo videos that will not resolve on Vercel until they are
re-uploaded. Neither blocks a push.

The 30 Oct pass verified the local app, the provider-health route, the
signed-in lesson UI, static PDF/VTT responses, the upload routes' auth/origin/size
rejections, the browser-bundle secret scan, and the workspace's course-media
inventory. It also ran the full local-video slice with a real upload, real signed
playback, real caption ingestion and a real `gemini-3.5-flash-lite` answer whose
citation seeked the player, plus a live insufficient-evidence refusal and the
timestamp rule that produced it. Lint, formatting, typecheck, the deterministic
suite of 96 tests, the normal build and the Vercel-targeted build all exited 0.

The 26 Oct record additionally covers Jina reranking, PDF/PPTX provenance,
Markdown/text/code ingestion, quizzes, exam and interview drills, persistence and
cross-account isolation. Those paths were not re-executed here.

The downloaded course's original video files are not local. Use the included
synthetic clip (already verified) or supply the original MP4s for local playback
of those lectures.

Not freshly re-verified: quiz/practice UI, sign-out, second-account UI, and
tasks/calendar/focus UI. Deferred: OCR, streaming, distributed quota accounting,
entity-level graph retrieval and automatic transcription. The health probe does
not report remaining provider quota; a small number of real provider calls were
made, all successful.

No Git command, repository initialisation, remote, commit or deployment was
performed in producing this report.

## 9. Safe cleanup pass (before GitHub push)

Performed 30 October 2026. No Git, GitHub, hosting, deployment, database writes or destructive Supabase operations were performed.

### 9.1 Removed (clutter / generated / mirrors)

| Item                                                                                                                                    | Reason                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.output/`, `.vercel/`, `.tanstack/`, `.wrangler/`                                                                                      | Build outputs and framework caches (regenerable)                                                                                                                               |
| `.local-run/`, `.freebuff/`, `.lovable/`                                                                                                | Local/dev state and per-machine markers                                                                                                                                        |
| `download/`, `external-resources/`, `lists/`, `pages/`, `resources/` (root), `static_resources/`*, `static_shared/`, `video_galleries/` | Downloaded mirrors / Lovable asset exports; gitignored and not required at runtime (course PDFs live in `public/course/`, data seeded in Supabase). Scripts to recreate exist. |
| `content_map.json`, `data.json` (root)                                                                                                  | Gitignored mirror metadata                                                                                                                                                     |

\* `static_resources/mit15_773_s24_lec01.pdf` was restored because `src/test/ingestion.test.ts` depends on it.

### 9.2 Deliberately retained

| Item                                                                                            | Reason                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/fixtures/` (including `spaced-repetition-demo.mp4`, `spaced-repetition-practice.pptx`) | Used by tests and documented manual workflows; legitimate fixtures.                  |
| `public/course/mit-15-773/` (14 PDFs + syllabus)                                                | Required by citations and runtime serving.                                           |
| `supabase/migrations/`                                                                          | Required to recreate schema.                                                         |
| All docs under `docs/`                                                                          | Authoritative setup/architecture/acceptance docs. README links retained.             |
| `bun.lock`, `bunfig.toml`                                                                       | Left in place per instructions (host uses `npm ci` via `vercel.json`).               |
| `src/integrations/supabase/client.server.ts`                                                    | Unused privileged helper; imported nowhere, no env var set. Documented, not deleted. |

### 9.3 `.gitignore`

No changes made in this pass (already updated in prior pass to exclude `.env*` (with `!.env.example`), `.vercel/`, build caches, `.local-run/`, `.freebuff/`, `supabase/.temp/`, mirrors, `*.tsbuildinfo`).

### 9.4 Validation after cleanup

| Check                               | Result                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `npx eslint .`                      | exit 0 — 0 errors, 8 pre-existing `react-refresh` warnings                                                             |
| `npx prettier --check .`            | exit 0 — all files clean                                                                                               |
| `npx tsc --noEmit`                  | exit 0                                                                                                                 |
| `npm test`                          | exit 0 — 96 passed, 14 opt-in live-provider tests skipped (after restoring `static_resources/mit15_773_s24_lec01.pdf`) |
| `npm run build`                     | exit 0 — Nitro/Cloudflare output regenerated                                                                           |
| `NITRO_PRESET=vercel npm run build` | exit 0 — `.vercel/output` regenerated                                                                                  |

### 9.5 Summary

- **Removed:** build outputs, caches, local state markers, and gitignored mirror trees (`download/`, `external-resources/`, `lists/`, `pages/`, root `resources/`, `static_resources/` (mostly), `static_shared/`, `video_galleries/`) plus root `content_map.json`/`data.json`. Restored one required PDF for tests.
- **Disk space reclaimed:** ~few hundred MB (mirrors + build artifacts).
- **Regressions:** None. All checks pass. Core routes and educational resources intact.
- **Ready for manual GitHub push:** Yes. No Git operations performed.

## 10. Production takeover (Vercel) — 30 October 2026

The prototype is now deployed and reachable at `https://horizonreboot.vercel.app/`.

### 10.1 What was wrong in production

The Vercel project served the downloaded MIT OpenCourseWare page instead of the
app: a mirror `index.html` sat at the repository root, so TanStack Start used it
as the HTML shell for every route (`[info] Using 'index.html' as renderer
template`). The root mirror files were removed and `vercel.json` now declares
`"framework": "tanstack-start"` with the Nitro Vercel build command.

### 10.2 Production configuration

| Setting                 | State                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Framework preset        | `tanstack-start` (repo config; project settings must match)                                                                 |
| Root / output directory | Repository root; no output-directory override                                                                               |
| Build / install command | `NITRO_PRESET=vercel npm run build` / `npm ci`                                                                              |
| Environment variables   | Supabase URL/key/project id (server + `VITE_`), Gemini, Groq and Jina keys — all set for production and preview             |
| Supabase Auth site URL  | `https://horizonreboot.vercel.app`; allowlist limited to that origin, the deployment origin, preview wildcard and localhost |
| Service-role key        | Not present in this workspace and not used by any browser code                                                              |

### 10.3 Uploads: direct to storage

A Vercel Function cannot receive a body larger than 4.5 MB, while the product
allows 10 MB documents and 200 MB videos. Both upload routes now work in two
small JSON calls: `sign` authorises one object path inside the learner's own
storage folder, the browser uploads straight to Supabase Storage with
`uploadToSignedUrl`, and `complete` re-checks ownership, size and container
signature before extracting and indexing. No file body passes through a
function, and the old multipart handlers are gone.

### 10.4 Defects found and fixed in this pass

1. **PDF extraction was broken in every built server.** pdf.js loads its worker
   through a relative dynamic import that a server bundle cannot follow, so all
   PDF uploads failed with `pdf_unreadable` while unit tests passed (they run
   unbundled). The worker module is now imported explicitly and registered on
   `globalThis.pdfjsWorker`.
2. **Real lecture PDFs failed to index.** Extracted text contained NUL/control
   bytes, which PostgreSQL rejects (`22P05 unsupported Unicode escape
sequence`). Extraction now strips them, with a regression test.
3. **API routes answered the HTML app shell.** A POST to `/api/ai/health`
   returned `200 text/html`, and unknown API paths returned the 404 page. API
   routes now answer `405` with an `Allow` header, and `/api/*` catch-all paths
   answer JSON `404`.
4. **Demo media and marketing assets pointed at retired preview URLs.**
   `src/assets/*.asset.json` pointed at `/__l5e/…`, which 404s anywhere outside
   the old preview host. The course cover and resource list now use tracked
   files, the dead pointer files are removed, and the three seeded demo lessons
   show an explicit "this demonstration video is no longer available" panel
   instead of a silent broken player.

### 10.5 Verification performed

| Check                                      | Result                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `npx vitest run`                           | 97 passed, 14 opt-in live-provider tests skipped                         |
| `npx tsc --noEmit`                         | exit 0                                                                   |
| `npm run lint`                             | exit 0 — 0 errors, 8 pre-existing `react-refresh` warnings               |
| `npx prettier --check .`                   | exit 0                                                                   |
| `npm run build`                            | exit 0                                                                   |
| `NITRO_PRESET=vercel npm run build`        | exit 0 — `.vercel/output/config.json` routes filesystem then `/__server` |
| Live workflow (`RUN_LIVE_WORKFLOW=1`)      | 7/7 with real Gemini + Groq fallback, PPTX ingestion, citations, refusal |
| Upload acceptance against the built server | 20/20 — see below                                                        |

The upload acceptance run used a real confirmed learner session and the real
Supabase project against the production build: no session → `401`, `.exe` →
`415`, 12 MB → `413`, foreign object path → `403`; a 4.76 MB PDF uploaded
directly to storage and indexed with page locators and embeddings; the 3.9 MB
MIT lecture PDF indexed into 108 passages; Markdown indexed; a 14.94 MB MP4
uploaded directly, attached to a new lesson and opened as `video/mp4`; every
temporary record and object was deleted afterwards.

### 10.6 Remaining limitations

- **Deferred:** OCR for scanned PDFs and image-only slides (rejected with a clear
  message), token streaming, distributed quota accounting (the ledger is
  in-memory and resets with the process), legacy `.ppt` conversion, and richer
  entity-level graph retrieval.
- **Deferred:** the three seeded demo lessons have no recoverable video file.
  Their transcripts, citations and tutoring still work.
- The Vercel project's framework preset, root directory and environment
  variables are dashboard settings; confirm them in the Vercel UI.
