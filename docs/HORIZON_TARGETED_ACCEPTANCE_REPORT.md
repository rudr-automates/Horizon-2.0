# Horizon targeted engineering acceptance report

Date: 1 November 2026
Branch: `codex/horizon-final-rebuild`
Base: `ea7350cc829c92f4625004761fc60d895f357c33` (`origin/main`)

## Changes

- Added a fail-closed claim-verification stage after the existing evidence ID,
  eligibility, and quote checks. Each answer sentence is separately checked by
  the configured AI gateway against the answer's cited, retrieved evidence.
  Gemini/Groq fallback still goes through the same verifier; malformed output,
  provider failure, non-supported verdicts, and invented verifier evidence IDs
  withhold the answer.
- Added `always`, `timeline`, and `unknown` document policies in existing
  `learning_resources.metadata` JSONB. No schema migration was required.
  Uploaders choose the policy; timeline ranges must be valid and within the
  lesson duration. Aligned pages/slides are withheld until their range end.
  Old resources with no policy are `unknown`; they are reference-only and only
  considered when the learner asks about a document/reference. The prompt and
  citation label distinguish unknown references from video coverage.
- Clarified that playable video links do not create transcript evidence, and
  that arbitrary YouTube transcription is not available. Existing manual
  timestamped SRT/WebVTT upload/paste and indexing remain the supported path.

Changed files: `src/server/retrieval/{types,scope,lesson-evidence.server,claim-verification}.ts`,
`src/server/ai/lesson-tutor.server.ts`, `src/server/ingestion/service.server.ts`,
`src/routes/api/resources/upload.ts`, `src/components/learning/{lesson-resources,lesson-tutor,import-video}.tsx`,
`src/lib/tutor-types.ts`, `src/test/{evidence,claim-verification}.test.ts`.

## Video transcription and processing

No automatic acquisition method is implemented. Official YouTube captions API
download requires the authenticated user to have permission to edit the video;
it is not a legitimate general route for arbitrary public links. Gemini video
understanding can analyze public YouTube URLs, but its documented feature is
multimodal question answering, not a guaranteed verbatim timestamped transcript.
Cloud Speech-to-Text batch processing requires configured Google Cloud storage
and credentials, neither of which is part of this deployment. No undocumented
caption extraction was added. Sources: [YouTube captions list](https://developers.google.com/youtube/v3/docs/captions/list),
[YouTube captions download](https://developers.google.com/youtube/v3/docs/captions/download),
[Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding),
[Google Cloud batch recognition](https://cloud.google.com/speech-to-text/v2/docs/batch-recognize).

The UI states that import/playback alone does not index a transcript and directs
learners to manual captions. Existing ingestion parses timestamped captions,
creates chunks, embeds when Jina is available, saves resource/chunk metadata,
and syncs cues to the Transcript panel. This turn verified those existing code
paths with local regression tests/builds, but did not run a live upload or
provider-backed transcription test.

## RAG correctness and resource scope

Existing hybrid retrieval, compatible stored/request-time embeddings, keyword
fallback, optional reranking, graph expansion, and video end-time filtering were
preserved. Document evidence is now policy-filtered before ranking and again
before it reaches generation. `always` resources are identified as references,
not watched video content. `timeline` resources require explicit start/end
metadata, matching lesson association, and an end within both lesson duration
and learner position. Unknown or malformed alignment is not treated as covered.

The existing in-memory authorized lesson subset and 80-chunk inline embedding
limit remain; this run did not benchmark realistic seeded-course latency or
retrieval quality. Database HNSW/GIN retrieval RPC remains a scalability task.

## Claim verification

The tutor first checks that each citation resolves to an eligible retrieved
item and any displayed quote matches exactly. It then splits the answer into at
most eight sentences and makes one bounded verifier request. The verifier only
receives the cited evidence already passed through owner/course/lesson and
temporal filtering. Every sentence must receive `supported`, cite only supplied
IDs, and appear exactly once. Provider failures propagate through the existing
safe error path. Any unsupported, contradicted, uncertain, malformed, missing,
or mismatched result refuses the full answer. The implementation uses a
semantic model judgment; it is not a mathematical proof of entailment.

Local contract tests cover supported/mixed verdicts, unsupported/contradicted/
uncertain outcomes, invented IDs, missing citations, malformed JSON, and
sentence splitting. They do not establish provider accuracy on adversarial
natural-language examples. Such live-provider checks were not run.

## Quality checks

- `corepack pnpm test`: **105 passed**, 14 opt-in tests skipped; 11 test files
  passed, 2 opt-in suites skipped.
- `corepack pnpm exec tsc --noEmit`: passed.
- `corepack pnpm lint`: passed with 0 errors and 8 existing Fast Refresh
  warnings outside the changed files.
- `corepack pnpm build`: passed. Existing large-chunk and tsconfig-paths
  notices were emitted.
- `NITRO_PRESET=vercel corepack pnpm build`: passed; Vercel output generated.
- `git diff --check`: passed.

These were local checks. No live Supabase mutation, account creation/deletion,
RLS cross-account attempt, or production acceptance request was made. No
Supabase development branch was available, so the 20-step live acceptance and
two-account isolation test remain unverified. Existing production rows and
accounts were not modified.

## Browser acceptance

Inspected the newest preview, deployment `dpl_6pHJZjPWLRAhiXE6zW7c2VpkFt58`,
URL `https://horizonreboot-j0xpkalyn-irrelevant3.vercel.app/`, for commit
`decbb7cdfd39cc7e47099642cb3bbaed863850d9`. It reached `READY`. Vercel
Deployment Protection required a temporary preview access link for the
isolated in-app browser; production protection/settings were not changed.

The browser document title was `Horizon 2.0 — Learning that understands your
context`; the landing page and branded Horizon mark rendered. The page declares
versioned `/favicon.svg?v=2`, `/favicon.ico?v=2`, and
`/apple-touch-icon.png?v=2`. Vercel returned 200 with `image/svg+xml`,
`image/vnd.microsoft.icon`, and `image/png` respectively; each used
`public, max-age=0, must-revalidate`. The SVG content is the Horizon mark. A
`/site.webmanifest` request returned 404 and no manifest link is declared. The
isolated browser screenshot API captures page content without browser chrome,
so the favicon glyph in the native tab strip could not be visually confirmed.
The icon assets and declarations passed, but the strict visible-tab-icon check
remains partially verified.

The clean preview tab reported no console warnings or errors. The preceding
Vercel login page emitted Google FedCM warnings/errors before the share link was
used; these were not emitted by the Horizon preview page. The public landing
page rendered; authenticated tutor/upload actions and API flows were not run.

## Deployment and remaining limitations

The source change is pushed to the review branch and the preview is READY.
Production and `main` remain untouched.

Remaining limitations: automatic YouTube/MP4 transcription; retryable
transcription worker and expanded 10-state progress reporting; live end-to-end
workflow and two-account RLS acceptance in a disposable database; provider
adversarial verifier evaluation; retrieval latency/quality measurements; and
visual browser-chrome favicon verification. No claim is made that those checks
passed.
