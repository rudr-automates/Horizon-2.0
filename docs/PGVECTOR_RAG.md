# Central PostgreSQL + pgvector RAG

Horizon now has a second, central retrieval layer beside the original
`resource_chunks` index. It stores timestamped transcript passages and their
Gemini embeddings in Supabase PostgreSQL and retrieves them with pgvector
similarity search before any model is called.

## Architecture

```
Upload / YouTube link
        │
        ▼
Existing ingestion pipeline (unchanged entry points)
  storage → Gemini transcription → timestamped VTT
        │
        ├──► learning_resources + resource_chunks (legacy 1024-d Jina index)
        │
        ▼
Central RAG indexer (src/server/rag)
  timestamp-aware overlapping chunks
  Gemini gemini-embedding-001 @ 768 dimensions
  video_chunks + video_indexes
        │
        ▼
Learner question / Explain / Summary / Quiz
        │
        ▼
server-authenticated lesson + position
        │
        ▼
match_video_chunks() SQL function
  security invoker → existing RLS
  lesson_id filter
  end_seconds <= playback position
  cosine similarity, top-K
        │
        ▼
EvidenceChunk contract (unchanged)
        │
        ▼
Existing scope checks → claim verification → Gemini/Groq
        │
        ▼
Grounded answer with clickable video timestamps
```

The model never receives the video, the full transcript, or another video's
passages. Only the retrieved, position-eligible chunks are placed in the prompt.

## Schema (additive)

Migration: `supabase/migrations/20261102100000_pgvector_rag.sql` (applied to the
connected project; PostgreSQL 17.11).

- **`video_chunks`** — `lesson_id`, `chunk_index`, text, `start_seconds`,
  `end_seconds`, `extensions.vector(768)`, embedding model/space metadata,
  content hash. Unique `(lesson_id, chunk_index)`, HNSW cosine index, and a
  `(lesson_id, end_seconds)` index.
- **`video_indexes`** — one row per lesson: `pending | processing | ready |
failed`, error, chunk count, source hash, model/dimension/space, indexed time.
- **`videos`** — read-only `security_invoker` projection over existing
  `public.lessons` plus index state. `lessons` remains the canonical video table;
  no data is duplicated and no existing column is changed.
- **`match_video_chunks(query_embedding, lesson_id, max_position_seconds,
match_count)`** — cosine similarity with the position boundary applied in SQL.
- **`list_covered_video_chunks(lesson_id, max_position_seconds, match_count)`**
  — chronological covered window used by summary, explain and quiz retrieval.

RLS is inherited from `lessons`: demo lessons are readable by everyone,
private lessons only by `user_id = auth.uid()`, and only the owner may write
index rows. The RPCs are `security invoker`; `anon` has no `EXECUTE` grant.

## Embedding space

| Value       | Setting                                   |
| ----------- | ----------------------------------------- |
| Provider    | Google Gemini (`GEMINI_API_KEY`, existing) |
| Model       | `gemini-embedding-001`                    |
| Dimensions  | **768**                                   |
| Metric      | cosine (`vector_cosine_ops`)              |
| Task types  | `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY` |
| Space key   | `gemini:gemini-embedding-001:768:2026-02-embedding-001-768` |

The dimension is enforced twice: by the provider response check and by
`vector_dims(embedding) = 768` in PostgreSQL. Vectors are never truncated.

## Chunking

`src/server/rag/chunking.ts` is pure and reusable:

- chronological transcript cues, timestamps retained;
- target ~110 words, hard max 170 words, **maximum 45 seconds**;
- ~28 words of overlap between adjacent chunks;
- long provider segments split at sentence (and then word) boundaries with
  proportional timestamps, so a 60-second segment cannot hide the opening of a
  lesson behind one eligibility gate;
- no text outside a segment's own time range.

A reindex is skipped when the source hash, chunk count and embedding space are
unchanged. Chunks are upserted by `(lesson_id, chunk_index)` and stale rows are
deleted, so duplicate insertion and interrupted jobs cannot leave a partial
index marked ready. If any embedding batch fails, all newly inserted rows are
removed, the index is marked `failed`, and the lesson is never reported ready.

## Ingestion integration

`ingestLessonResource` runs the existing path unchanged, then indexes the video
transcript through the central service. The upload/link workflows, storage
buckets, Gemini transcription, legacy embeddings, UI and routes are untouched.

If the vector index cannot be built (for example an embedding quota failure),
the transcript still becomes available and the tutor/quiz fall back to the
legacy hybrid path. The lesson's index status stays `failed`, not `ready`.
Retrying the ingestion job repairs the index from the stored transcript.

## Retrieval integration

`src/server/rag/service.server.ts` is the only embedding/search implementation
used by the features:

- **Tutor**: `match_video_chunks` over the lesson, position-gated, top 8.
- **Explain simply**: semantic matches plus the three passages immediately
  before the playhead, so the explanation is about the current point.
- **Summarize so far**: `list_covered_video_chunks`, chronological, never a
  similarity search over future material.
- **Quiz**: semantic retrieval over covered material, then the existing
  evidence validation.

All four still go through `selectEligibleEvidence` and the existing citation and
claim verification. Reference questions ("PDF", "notes", "slides") continue to
use the wider resource index so documents are not lost.

## Preloaded MIT content

`scripts/ingest-mit-course.mjs` only ever wrote the legacy tables; the new index
is populated by `src/test/rag-backfill.live.test.ts` (service-role, in-memory
key) from each lesson's stored timestamped transcript.

Current state of the connected project: **1,089 chunks / 14 ready lessons** —
all 11 MIT lectures and the 3 demo micro-lessons. The one-off backfill is
idempotent, so it can be re-run after a transcript or embedding-model change:

```bash
cd Horizon-2.0-main
set -a && . ./env && . ./.env && . ./env.e2e && set +a
RUN_LIVE_RAG_INDEX=1 npx vitest run src/test/rag-backfill.live.test.ts
```

## Configuration

No new required environment variable. The pipeline reuses `GEMINI_API_KEY`.
A second Gemini API key / Google project, or billing enabled on the existing
project, is required only to finish embedding the remaining lectures today:
the free tier allows **1,000 embedding requests per day** and each chunk is one
request.

Apply the migration with the Supabase CLI or SQL editor. It is additive; no
existing table, policy, route or component was removed.

## Verification

Offline: `npm test` — 116 passed, 17 opt-in skipped (includes 3 new chunker
tests). `npx tsc --noEmit`, ESLint on changed files and `npm run build` pass.

Live (connected project):

- `match_video_chunks` returns the source chunk as the top hit and returns zero
  rows when the position is before that chunk.
- The central summary window returns only chunks with `end_seconds <= 600` for
  the MIT lesson at 10:00.
- Summarize So Far answered through the pgvector path with bounded citations.
- A private lesson's chunks are invisible to an anonymous client (function
  permission denied) and to a second signed-in learner (zero rows), while the
  owner retrieves them.
- A **real 123-second MP4 upload** went through storage → Gemini transcription →
  timestamped chunking → Gemini embeddings → `video_chunks`, and its index
  reported `ready` with `gemini-embedding-001` at 768 dimensions.
- On that uploaded lesson: tutor question answered with a timestamped citation
  (`retrieval: semantic`), Explain Simply answered, Summarize So Far answered
  (`retrieval: summary`), and quiz generation returned `ready` with four-option
  questions. At 5 seconds the tutor returned `insufficient_evidence` and cited
  nothing beyond the playhead.
- A fresh private lesson ingested through the caption path indexed automatically
  and answered all four features; at 10 seconds the later interleaving material
  was not eligible.

One live summary attempt returned `citation_invalid` because the model produced
an unverifiable reply; an immediate retry answered correctly. This is the
existing fail-closed answer verification, not a retrieval failure.

## Limitations

- The free Gemini embedding tier is 1,000 requests/day. A 45-minute lecture is
  roughly 70–110 chunks, so a full course backfill may need multiple days or a
  paid/second project key. All 14 current lessons are already indexed.
- Query embeddings also consume the same daily quota. When they are unavailable
  the central service returns `null` and the existing hybrid Jina/keyword
  retrieval is used, so answers still work but without pgvector ranking.
- A chunk becomes eligible when its end timestamp is reached. With the 45-second
  cap, the first passage of a lesson is available after at most 45 seconds of
  playback. Earlier positions correctly have no covered evidence.
- Provider timestamps are model estimates; the position gate is exact against
  those estimates and always uses the chunk's end time.
- YouTube/Vimeo links still require a readable caption track; direct uploads are
  transcribed automatically.
- Very long recordings can exceed embedding quota or provider limits; the index
  is marked failed and retried, never marked ready.
