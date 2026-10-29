# Horizon 2.0 — Phase 2 completion report

Date: 2026-10-26

This report distinguishes **verified with real providers**, **verified
deterministically**, and **still incomplete**. No Git, GitHub or deployment
operation was performed.

## 1. Supabase state

The connected project was inspected before changes. Existing learner tables and
rows were preserved. These migrations are recorded as applied:

- `20261021170219`, `20261021170304`, `20261021174428`, `20261021174550`,
  `20261024151435` — original profiles, learning and demo data.
- `20261025170500` — focus/task ownership guard.
- `20261025171000` — pgvector, `learning_resources`, `resource_chunks`,
  `tutor_exchanges`, `quiz_attempts`, indexes and RLS.
- `20261026130000` — private `learning-resources` storage bucket, owner-folder
  policies and a 10 MB file limit.

Verified with the service role and learner clients:

| Item                                 | Count / result                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| MIT lessons                          | 11                                                                                           |
| Indexed resources                    | 26 (11 transcripts, 14 PDFs, 1 syllabus)                                                     |
| Passages                             | 3,691                                                                                        |
| Passages with Jina vectors           | 3,691                                                                                        |
| Embedding space                      | `jina:jina-embeddings-v3:1024:2024-09-v3-1024`                                               |
| Anonymous read of a private resource | 0 rows                                                                                       |
| Bucket visibility                    | private                                                                                      |
| RLS policies                         | active on all four new tables and storage objects                                            |
| Vector index                         | HNSW + GIN indexes exist; the request path ranks the pre-authorized lesson subset in memory. |

## 2. Grounded tutor workflow

The complete path was exercised with a real signed-in learner, the real Supabase
project, real Jina embeddings/reranking and a real Gemini call:

1. The lesson and duration come from the learner's RLS-scoped client.
2. The client timestamp is validated against the stored duration.
3. Only evidence ending at or before that timestamp is eligible; documents remain
   eligible. Citations in the live answer ended at or before the tested position.
4. The query is embedded and fused with keyword ranking; Jina reranking is
   applied when configured.
5. Gemini answered from the eligible evidence. Every citation was verified against
   the pre-generation evidence set and its quote matched.
6. A PDF citation returned HTTP 200 from the app's public course path; a private
   upload citation returned HTTP 200 through a signed URL.
7. An unrelated question produced a refusal (`insufficient_evidence`) rather than
   an unsupported answer.

Live quick-quiz, exam-drill and interview-drill runs produced persisted
questions, scores and per-question citations. Tutor feedback and quiz attempts
are stored under the caller's user id. During the exam run the per-model
application limit skipped Gemini and Groq answered instead, exercising the
bounded free-tier fallback in a real request. The live suite deletes its
temporary uploaded resources; it intentionally leaves its private tutor and quiz
records in the dedicated e2e learner account as evidence of persistence.

## 3. Providers

| Provider        | Integration                               | Live result                       |
| --------------- | ----------------------------------------- | --------------------------------- |
| Gemini          | `providers/gemini.ts`, JSON response mode | Passed                            |
| Groq            | `providers/groq.ts`, JSON response mode   | Passed                            |
| Jina embeddings | `embeddings/jina.ts`, 1,024 dimensions    | Passed                            |
| Jina reranking  | `retrieval/rerank.ts`                     | Passed                            |
| Gateway         | Gemini primary, Groq bounded fallback     | Passed, including a live fallback |

Only explicitly free-tier models are selectable. `allowPaidModels` must remain
`false`; paid configuration fails validation. The runtime does not switch to a
paid provider on quota exhaustion. Client-facing errors distinguish
missing credentials, authentication failure, rate limit, exhausted quota,
timeout, provider outage and invalid citations.

The development server was confirmed to load the root `.env`:
`GET /api/ai/health` returned `ready` with Gemini, Groq and Jina configured and
`paidFallback: false`. It never returns key values.

## 4. Ingestion

Implemented in `src/server/ingestion/` and exposed at
`POST /api/resources/upload`:

- PDF: page-aware extraction with `pdfjs-dist`; page locators and page count.
- PPTX: OOXML slide and speaker-note extraction; slide locators.
- Legacy `.ppt`: rejected with a "save as .pptx" message.
- Markdown, text and common code files: paragraph/sentence chunking and text
  locators.
- SRT/WebVTT: timestamped video evidence, rejected if it runs past the lesson
  duration.
- Private storage under `<user-id>/<resource-id>.<ext>` with owner-only RLS.
- Jina embeddings with space metadata on every vector. If Jina is unavailable,
  passages are still stored for keyword retrieval and the response reports that
  semantic indexing was unavailable.
- Limits: 10 MB, 220 passages, one indexed transcript per lesson.
- A real text upload returned HTTP 201, one chunk, one Jina vector; the owner
  could read it, an anonymous client could not, and the signed citation opened.
- A real two-slide PPTX upload produced two slide-located chunks and two Jina
  vectors; the fixture used in that live test included real OOXML slide XML.

Deterministic extraction tests cover a real 110-page MIT PDF, a generated PPTX
with speaker notes, WebVTT timing, text/code, legacy PPT rejection and transcript
duration mismatch.

## 5. Educational resources actually present

| Type                     | Location                                                        | Status                                                       |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Lecture captions         | `static_resources/15773-sp24-lecture-*-captions.vtt` (11 files) | Local, parsed and seeded                                     |
| Lecture note PDFs        | `static_resources/mit15_773_s24_lec*.pdf` (14 files)            | Local, extracted and seeded                                  |
| Served PDFs              | `public/course/mit-15-773/*.pdf` (14 files)                     | Local, HTTP 200                                              |
| Syllabus                 | `public/course/mit-15-773/syllabus.md`                          | Local, seeded                                                |
| Lecture videos           | 11 YouTube URLs in `video_galleries/lecture-videos/data.json`   | Remote; no local MP4/WebM                                    |
| PPTX                     | `src/assets/course-slides.pptx.asset.json`                      | Remote Lovable-hosted pointer; no local PPTX file            |
| Original sample PDF/PPTX | `src/assets/*.asset.json`                                       | Remote pointers; not used by the current Study materials tab |

There are **no local video files** in the workspace. Playback uses the verified
YouTube URLs; one lecture URL returned HTTP 200 during verification. The user
should supply local MP4/WebM files or a PPTX deck if those exact formats are
required for their own course.

## 6. Verification results

| Check                               | Result                             |
| ----------------------------------- | ---------------------------------- |
| `npx tsc --noEmit`                  | Pass                               |
| `npm test` (deterministic)          | 90 passed, 14 opt-in tests skipped |
| `RUN_REAL_AI_SMOKE=1` suite         | 7 passed                           |
| `RUN_LIVE_WORKFLOW=1` suite         | 7 passed                           |
| `npm run build` (Cloudflare/Nitro)  | Pass                               |
| `NITRO_PRESET=vercel npm run build` | Pass; `.vercel/output` generated   |
| `/api/ai/health` on the dev server  | 200, all providers configured      |
| Home and sign-in routes             | 200                                |
| Upload without a token              | 401                                |
| Targeted ESLint on changed files    | Pass                               |

Project-wide `npm run lint` still reports a pre-existing Prettier baseline of
roughly 1,200 errors across older files. Formatting the whole repository was not
done because it would create a large unrelated diff; all newly added and edited
code files pass targeted ESLint.

## 7. Still incomplete or not live-verified

- A PowerPoint-authored deck is not present in the workspace. PPTX ingestion is
  live-verified with a generated OOXML deck, not with an actual downloaded file.
- OCR for scanned PDFs and image-only slide decks.
- Full browser automation of a signed-in UI session. The server workflow, database
  persistence, HTTP upload route and rendered build were verified; interactive UI
  clicks remain a manual check.
- Token streaming and a distributed quota ledger.
- Entity/knowledge-graph retrieval beyond the current timestamp-adjacent
  transcript graph.
- Instructor workspace, production deployment, custom domains and observability
  beyond structured logs.
- Vercel was built locally but not deployed.

## 8. Required follow-up from the user

If Vercel deployment is next, set the Supabase and AI variables from
[local setup](LOCAL_SETUP.md) in the Vercel project. `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are needed at build time; provider keys and
`SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` are needed at runtime. No key belongs in
the repository or the browser bundle.
